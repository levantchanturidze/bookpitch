-- audit_log: declarative RANGE partitioning by `at` (monthly).
--
-- Rationale: audit_log is the largest by-row-count table long-term
-- (every read of a customer surface writes a row). Monthly partitions
-- give us cheap DROP-old-partition retention + fast per-month queries.
--
-- Postgres requires the partition key to be part of every unique constraint,
-- including the PK. So the PK moves from (id) → (at, id). The `id` sequence
-- still guarantees per-row uniqueness in practice; queries that filter by
-- `id` alone still work (they scan partitions but the idx_audit_at index
-- keeps recent queries hot).
--
-- Strategy — safe on both an empty and a populated table:
--   1. Rename current audit_log → audit_log_legacy.
--   2. Create audit_log as PARTITION BY RANGE (at) with the new PK.
--   3. Create partitions for the year the legacy data lives in +
--      last-6 / current / next-3 months so contemporary writes fit.
--   4. Copy data across. Create a default partition to absorb anything
--      that falls outside the covered range.
--   5. Drop legacy. Re-create RLS + indexes on the parent (they cascade
--      to partitions).
--   6. Install bp_create_monthly_partition() helper for the rollover cron.

BEGIN;

-- Step 1 — swap the current table out of the way.
ALTER TABLE "audit_log" RENAME TO "audit_log_legacy";
-- Drop its constraints/indices we don't want to duplicate on the new
-- parent (they'd conflict on name).
ALTER TABLE "audit_log_legacy" RENAME CONSTRAINT "audit_log_pkey" TO "audit_log_legacy_pkey";
ALTER INDEX "idx_audit_entity" RENAME TO "idx_audit_entity_legacy";
ALTER INDEX "idx_audit_actor"  RENAME TO "idx_audit_actor_legacy";
ALTER TABLE "audit_log_legacy" RENAME CONSTRAINT "audit_log_organization_id_fkey" TO "audit_log_legacy_organization_id_fkey";
ALTER TABLE "audit_log_legacy" RENAME CONSTRAINT "audit_log_actor_user_id_fkey" TO "audit_log_legacy_actor_user_id_fkey";
-- Move the legacy sequence's ownership too so the new table gets a fresh one.
ALTER SEQUENCE IF EXISTS "audit_log_id_seq" RENAME TO "audit_log_legacy_id_seq";

-- Step 2 — new partitioned parent.
CREATE TABLE "audit_log" (
    "id"              BIGSERIAL,
    "organization_id" UUID,
    "actor_user_id"   UUID,
    "action"          TEXT           NOT NULL,
    "entity"          TEXT           NOT NULL,
    "entity_id"       UUID,
    "at"              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "ip"              INET,
    "meta"            JSONB,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("at", "id"),
    CONSTRAINT "audit_log_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL,
    CONSTRAINT "audit_log_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL
) PARTITION BY RANGE ("at");

-- Continue the id sequence from wherever the legacy left off so writes
-- during the swap don't collide.
SELECT setval(
    pg_get_serial_sequence('audit_log', 'id'),
    GREATEST(1, (SELECT COALESCE(MAX(id), 0) FROM "audit_log_legacy")),
    true
);

-- Step 3 — partitions.
--
-- Helper: creates a monthly partition idempotently. We ship it now
-- because both the initial fill and the rollover cron use it.
CREATE OR REPLACE FUNCTION bp_create_monthly_partition(parent regclass, month date)
RETURNS void AS $$
DECLARE
    part_name text;
    start_ts  timestamptz;
    end_ts    timestamptz;
BEGIN
    start_ts := date_trunc('month', month::timestamptz);
    end_ts   := start_ts + INTERVAL '1 month';
    part_name := parent::text || '_' || to_char(start_ts, 'YYYY_MM');
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, start_ts, end_ts
    );
END;
$$ LANGUAGE plpgsql;

-- Cover: everything the legacy table currently holds + last 6 months +
-- current + next 3 months. Overshoot doesn't cost anything; missing
-- coverage would send writes to the default partition (slow to prune).
DO $$
DECLARE
    m date;
    legacy_min date;
    legacy_max date;
BEGIN
    SELECT date_trunc('month', MIN("at"))::date,
           date_trunc('month', MAX("at"))::date
      INTO legacy_min, legacy_max
      FROM "audit_log_legacy";
    IF legacy_min IS NULL THEN legacy_min := (CURRENT_DATE - INTERVAL '6 month')::date; END IF;
    IF legacy_max IS NULL THEN legacy_max := (CURRENT_DATE + INTERVAL '3 month')::date; END IF;

    m := LEAST(legacy_min, (CURRENT_DATE - INTERVAL '6 month')::date);
    WHILE m <= GREATEST(legacy_max, (CURRENT_DATE + INTERVAL '3 month')::date) LOOP
        PERFORM bp_create_monthly_partition('audit_log'::regclass, m);
        m := (m + INTERVAL '1 month')::date;
    END LOOP;
END $$;

-- Default partition — absorbs anything outside the covered range so
-- writes never fail. We monitor its size and expect it to stay ~0.
CREATE TABLE "audit_log_default" PARTITION OF "audit_log" DEFAULT;

-- Step 4 — copy data.
INSERT INTO "audit_log" (
    "id", "organization_id", "actor_user_id", "action",
    "entity", "entity_id", "at", "ip", "meta"
)
SELECT "id", "organization_id", "actor_user_id", "action",
       "entity", "entity_id", "at", "ip", "meta"
  FROM "audit_log_legacy";

-- Step 5 — indices on the parent cascade to every partition + future
-- partitions.
CREATE INDEX "idx_audit_entity" ON "audit_log" ("entity", "entity_id");
CREATE INDEX "idx_audit_actor"  ON "audit_log" ("actor_user_id", "at" DESC);
CREATE INDEX "idx_audit_at"     ON "audit_log" ("at" DESC);
CREATE INDEX "idx_audit_org_at" ON "audit_log" ("organization_id", "at" DESC);

-- RLS + tenant_isolation policy — matches the legacy policy behaviour.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
    USING       (organization_id = current_org_id() OR organization_id IS NULL)
    WITH CHECK  (organization_id = current_org_id() OR organization_id IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_log" TO bookpitch_app;

-- Legacy table no longer needed.
DROP TABLE "audit_log_legacy" CASCADE;

COMMIT;
