-- =============================================================================
-- Row-Level Security — tenant isolation at the database layer.
--
-- schema.sql sketches Supabase-style policies keyed on `auth.jwt() ->> 'org_id'`.
-- Since we're on plain Postgres with Auth.js (no auth.jwt() function), we use
-- a per-request custom setting `app.current_org_id`, set by the app inside a
-- transaction. See lib/db.ts for the Prisma extension that wires this.
--
-- A bug in application code cannot leak one tenant's data to another: the
-- database rejects the query.
-- =============================================================================

-- Helper — extracts the current org id from the session-scoped GUC.
-- Returns NULL if unset (which means all policies fail closed).
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$;

-- -----------------------------------------------------------------------------
-- Enable RLS + tenant_isolation policy on every tenant-owned table.
-- -----------------------------------------------------------------------------

-- organizations: readable only if it IS the caller's org.
-- FORCE so even the DB owner (running the app locally) is subject to policies.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations"
    USING (id = current_org_id())
    WITH CHECK (id = current_org_id());

-- All other tenant tables share the same shape: organization_id = caller's.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'locations','staff','services','customers','appointments',
        'payments','message_templates','message_log','notifications',
        'memberships'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
             USING (organization_id = current_org_id())
             WITH CHECK (organization_id = current_org_id());', t);
    END LOOP;
END $$;

-- staff_availability: no organization_id column; scope via parent staff row.
ALTER TABLE "staff_availability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_availability" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "staff_availability"
    USING (staff_id IN (SELECT id FROM staff WHERE organization_id = current_org_id()))
    WITH CHECK (staff_id IN (SELECT id FROM staff WHERE organization_id = current_org_id()));

-- treatment_history: same, scoped via parent customer.
ALTER TABLE "treatment_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treatment_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "treatment_history"
    USING (customer_id IN (SELECT id FROM customers WHERE organization_id = current_org_id()))
    WITH CHECK (customer_id IN (SELECT id FROM customers WHERE organization_id = current_org_id()));

-- audit_log: cross-org actors can exist (e.g. system tasks); scope on
-- organization_id when present, but allow NULL for org-agnostic entries.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
    USING (organization_id = current_org_id() OR organization_id IS NULL)
    WITH CHECK (organization_id = current_org_id() OR organization_id IS NULL);

-- -----------------------------------------------------------------------------
-- NOTE ON app_users: NOT tenant-scoped. A user may belong to multiple orgs
-- via memberships; the auth layer looks them up before we know which org
-- context to use. Leave RLS off — access is filtered by explicit queries.
-- -----------------------------------------------------------------------------
