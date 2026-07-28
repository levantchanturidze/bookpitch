-- =============================================================================
-- RBAC Phase 2 — DB-level sync triggers.
--
-- The single-window backfill (20260728000000_rbac_backfill) fills existing
-- rows once. After cutover the application still writes to the OLD shape
-- (memberships.role enum, locations, organizations without vertical / owner
-- pointer) until Phase 4 rewrites the write paths. Without something in the
-- middle, every new signup drifts back to the pre-backfill state.
--
-- These triggers close that gap at the DB layer with zero app-code churn:
-- whenever the app inserts a row via the old shape, the trigger fills the
-- new columns (or the linked branches row) using the same mapping the
-- backfill used.
--
-- REMOVED IN PHASE 4 once every write path writes both models natively.
-- Down migration is intentionally clean so Phase 4 can just apply this
-- migration's down.sql.
--
-- Style follows prisma/migrations/20260727170000_rbac_audit_log_append_only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared helper: resolve a UserRole enum value to a system roles.id.
-- Immutable within a session (roles.id doesn't change), so callers can rely
-- on the return being stable.
--
-- Returns NULL if no matching system role is seeded — the trigger below
-- falls back to leaving role_id NULL rather than raising, so an unexpected
-- enum value doesn't block the write.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac_role_id_for_user_role(r user_role)
RETURNS uuid AS $$
    SELECT id FROM "roles"
     WHERE organization_id IS NULL
       AND key = CASE r
                   WHEN 'owner'        THEN 'ORG_OWNER'
                   WHEN 'practitioner' THEN 'PROVIDER'
                   WHEN 'receptionist' THEN 'FRONT_DESK'
                 END
$$ LANGUAGE sql STABLE;

-- -----------------------------------------------------------------------------
-- 1. memberships: fill role_id / joined_at / is_bookable when the app
--    writes only the old (role, created_at) pair.
--
--    BEFORE trigger so the values are written in the same UPDATE — no
--    second write, no extra row version. Skips when role_id is already
--    set (e.g. Phase 4+ code that writes it directly).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac_memberships_sync() RETURNS trigger AS $$
BEGIN
    IF NEW.role_id IS NULL AND NEW.role IS NOT NULL THEN
        NEW.role_id := rbac_role_id_for_user_role(NEW.role);
    END IF;
    IF NEW.joined_at IS NULL THEN
        NEW.joined_at := COALESCE(NEW.created_at, CURRENT_TIMESTAMP);
    END IF;
    -- Bookable rule matches the backfill: owner + practitioner default TRUE,
    -- everyone else FALSE. Phase 6 exposes a UI toggle; until then the DB
    -- default (false) still governs any write that overrides this to false.
    IF TG_OP = 'INSERT' AND NEW.role IN ('owner','practitioner') THEN
        NEW.is_bookable := TRUE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_rbac_sync
    BEFORE INSERT OR UPDATE OF role, role_id, joined_at, is_bookable
    ON "memberships"
    FOR EACH ROW EXECUTE FUNCTION rbac_memberships_sync();

-- -----------------------------------------------------------------------------
-- 2. locations → branches: mirror insert/update/delete into the new table.
--
--    AFTER trigger because branches has its own FK back to locations.id
--    (legacy_location_id). Idempotency is expressed as WHERE NOT EXISTS
--    rather than ON CONFLICT — Phase 1's unique index on legacy_location_id
--    is partial (WHERE legacy_location_id IS NOT NULL), which Postgres
--    ON CONFLICT syntax cannot infer without repeating the predicate.
--
--    Also opportunistic: if the parent org has NULL vertical (backfill
--    couldn't fill it because the org had zero locations at the time), we
--    seed vertical from the location's type on first insert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac_locations_sync_insert() RETURNS trigger AS $$
BEGIN
    INSERT INTO "branches" (organization_id, name, timezone, legacy_location_id)
    SELECT NEW.organization_id, NEW.name, NEW.timezone, NEW.id
     WHERE NOT EXISTS (
             SELECT 1 FROM "branches" WHERE legacy_location_id = NEW.id
           );

    -- Backfill org.vertical if this is the first location and vertical is
    -- still NULL. Cheap SELECT + UPDATE, gated on vertical IS NULL to stay
    -- a no-op for orgs that already have one.
    UPDATE "organizations"
       SET vertical = NEW.type::text
     WHERE id = NEW.organization_id
       AND vertical IS NULL;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER locations_rbac_sync_insert
    AFTER INSERT ON "locations"
    FOR EACH ROW EXECUTE FUNCTION rbac_locations_sync_insert();

CREATE OR REPLACE FUNCTION rbac_locations_sync_update() RETURNS trigger AS $$
BEGIN
    -- Only touches the linked branch (via the 1:1 legacy_location_id).
    -- If the location has no branch yet (shouldn't happen post-Phase-2,
    -- but defensively handled), do nothing.
    UPDATE "branches"
       SET name     = NEW.name,
           timezone = NEW.timezone
     WHERE legacy_location_id = NEW.id
       AND (name IS DISTINCT FROM NEW.name OR timezone IS DISTINCT FROM NEW.timezone);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER locations_rbac_sync_update
    AFTER UPDATE OF name, timezone ON "locations"
    FOR EACH ROW EXECUTE FUNCTION rbac_locations_sync_update();

--    BEFORE DELETE (not AFTER): Phase 1 declared branches.legacy_location_id
--    with ON DELETE SET NULL — an AFTER trigger would find the FK already
--    nulled and delete zero rows, leaving an orphan branch. BEFORE fires
--    while the pointer is still intact.
CREATE OR REPLACE FUNCTION rbac_locations_sync_delete() RETURNS trigger AS $$
BEGIN
    DELETE FROM "branches" WHERE legacy_location_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER locations_rbac_sync_delete
    BEFORE DELETE ON "locations"
    FOR EACH ROW EXECUTE FUNCTION rbac_locations_sync_delete();
