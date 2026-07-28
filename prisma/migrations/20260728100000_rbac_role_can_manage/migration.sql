-- =============================================================================
-- RBAC Phase 3 — role_can_manage lattice.
--
-- Ranks are not a chain (spec §4.2 warning): FRONT_DESK and PROVIDER both
-- sit at rank 40 but operate in different domains. Numeric rank alone would
-- let FRONT_DESK "manage" PROVIDER and vice-versa. The lattice is an
-- explicit adjacency list; `can_manage_role_assignment()` in lib/rbac/rank.ts
-- requires BOTH numeric rank (anti-escalation) AND membership in this table.
--
-- Data-only table — no RLS, no organization scope. Every row is a system
-- assertion about the role graph. Custom roles (spec §11 v3) will get their
-- own edges added by the org owner via a Phase 6 UI.
-- =============================================================================

CREATE TABLE "role_can_manage" (
    "parent_role_id" UUID           NOT NULL,
    "child_role_id"  UUID           NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_can_manage_pkey"
        PRIMARY KEY ("parent_role_id","child_role_id"),
    CONSTRAINT "role_can_manage_parent_fkey"
        FOREIGN KEY ("parent_role_id") REFERENCES "roles"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_can_manage_child_fkey"
        FOREIGN KEY ("child_role_id")  REFERENCES "roles"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- Belt: no role manages itself. A self-loop would let ORG_ADMIN
    -- reshape its own permissions, which spec §9 rule 3 forbids.
    CONSTRAINT "role_can_manage_no_self"
        CHECK ("parent_role_id" <> "child_role_id")
);

-- Index for the hot query: "what can this role manage?"
CREATE INDEX "idx_role_can_manage_parent" ON "role_can_manage"("parent_role_id");
