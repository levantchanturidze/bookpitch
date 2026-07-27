-- =============================================================================
-- RBAC Phase 1 — roles, permissions, role_permissions.
-- Spec §3. These tables are new (no existing analog).
--
-- Design notes:
--   • System roles have organization_id = NULL and a globally-unique key.
--     Custom (per-org) roles have organization_id set and key unique inside
--     that org. Two partial unique indexes enforce both cases.
--   • `plane` is TEXT with a CHECK — enums require ALTER TYPE gymnastics
--     when we add values later.
--   • `rank` is a lattice, not a chain (spec §4.2 warning). Do not use rank
--     as the only "can manage" input in Phase 3 — combine with an explicit
--     can_manage_roles table (added in Phase 6 if needed).
--   • RLS is intentionally NOT enabled on these three tables. Rationale:
--       - System rows have org_id = NULL; RLS predicates on organization_id
--         would filter them out for every caller.
--       - The auth core (Phase 3) reads roles/permissions frequently to
--         build the permission set for `can()`.
--       - Custom-role isolation is enforced at query time by callers that
--         write custom roles (Phase 6).
--     `bookpitch_app` gets DML via the schema-wide default privileges from
--     migration 20260722000003.
-- =============================================================================

CREATE TABLE "roles" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "key"             TEXT           NOT NULL,
    "display_name"    TEXT           NOT NULL,
    "plane"           TEXT           NOT NULL,
    "rank"            INTEGER        NOT NULL,
    "organization_id" UUID,
    "is_system"       BOOLEAN        NOT NULL DEFAULT false,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "roles_plane_check"
        CHECK ("plane" IN ('platform','organization','consumer')),
    CONSTRAINT "roles_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- System roles: key is globally unique when org_id is NULL.
CREATE UNIQUE INDEX "roles_system_key_unique"
    ON "roles"("key") WHERE "organization_id" IS NULL;
-- Custom roles: key is unique per org.
CREATE UNIQUE INDEX "roles_org_key_unique"
    ON "roles"("organization_id","key") WHERE "organization_id" IS NOT NULL;

CREATE INDEX "idx_roles_plane"    ON "roles"("plane");
CREATE INDEX "idx_roles_org"      ON "roles"("organization_id") WHERE "organization_id" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- permissions — reference data. `key` (e.g. "booking.read:branch") is the
-- primary key; resource/action/scope are decomposed for querying and to make
-- the seed self-documenting.
-- -----------------------------------------------------------------------------
CREATE TABLE "permissions" (
    "key"         TEXT           NOT NULL,
    "resource"    TEXT           NOT NULL,
    "action"      TEXT           NOT NULL,
    "scope"       TEXT,
    "description" TEXT,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "permissions_scope_check"
        CHECK ("scope" IS NULL OR "scope" IN
               ('own','branch','org','platform','limited','unlimited','any','basic','contact','full'))
);

CREATE INDEX "idx_permissions_resource" ON "permissions"("resource");

-- -----------------------------------------------------------------------------
-- role_permissions — many-to-many bundle.
-- -----------------------------------------------------------------------------
CREATE TABLE "role_permissions" (
    "role_id"        UUID           NOT NULL,
    "permission_key" TEXT           NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key"),
    CONSTRAINT "role_permissions_role_id_fkey"
        FOREIGN KEY ("role_id") REFERENCES "roles"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_permission_key_fkey"
        FOREIGN KEY ("permission_key") REFERENCES "permissions"("key")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_role_permissions_permission" ON "role_permissions"("permission_key");
