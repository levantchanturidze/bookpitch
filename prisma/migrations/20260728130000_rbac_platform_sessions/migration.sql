-- =============================================================================
-- RBAC Phase 5 — impersonation + break-glass session tables.
--
-- Spec §7.1 (impersonation) and §7.2 (break-glass) call for time-bounded
-- sessions with mandatory reason + ticket ID, per-request restriction
-- enforcement, and every read audited during a break-glass window.
--
-- Both tables are platform-plane bookkeeping — no RLS. Queried by
-- lib/rbac/context.ts::buildAuthContext once per session (bounded by the
-- 30s AuthContext cache) to populate ctx.impersonation / ctx.breakGlass.
--
-- FKs use ON DELETE NO ACTION: session rows outlive their actor / target
-- for evidentiary purposes, same rationale as audit_log (Phase 1 §7.1).
-- Deleting a user with impersonation history requires the same escape
-- hatch as deleting a user with audit history — mask, don't purge.
-- =============================================================================

CREATE TABLE "impersonation_sessions" (
    "id"                    UUID           NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id"         UUID           NOT NULL,
    -- The org-plane user whose account the actor is inside.
    "on_behalf_of_user_id"  UUID           NOT NULL,
    "organization_id"       UUID           NOT NULL,
    -- Spec §7.1 rule 2: reason is mandatory; ticket_id is the customer
    -- support ticket that authorises the session. Both stored for audit.
    "reason"                TEXT           NOT NULL,
    "ticket_id"             TEXT           NOT NULL,
    "started_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"            TIMESTAMPTZ(6) NOT NULL,
    -- ended_at NULL = active. Set to CURRENT_TIMESTAMP on explicit end
    -- or by a housekeeping sweep for expired-but-not-ended sessions.
    "ended_at"              TIMESTAMPTZ(6),
    "ended_reason"          TEXT,
    "ip"                    INET,
    "user_agent"            TEXT,
    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "impersonation_sessions_actor_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "impersonation_sessions_on_behalf_of_fkey"
        FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "impersonation_sessions_org_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    -- Belt: reason must have meaningful content, ticket_id too.
    CONSTRAINT "impersonation_sessions_reason_length"
        CHECK (char_length(reason) >= 5),
    CONSTRAINT "impersonation_sessions_ticket_length"
        CHECK (char_length(ticket_id) >= 1),
    CONSTRAINT "impersonation_sessions_expires_future"
        CHECK (expires_at > started_at)
);

-- Hot query: "is there an active impersonation session for this actor?"
-- Partial index — only active rows, which is what buildAuthContext hits.
CREATE INDEX "idx_impersonation_sessions_actor_active"
    ON "impersonation_sessions"("actor_user_id")
    WHERE "ended_at" IS NULL;

CREATE INDEX "idx_impersonation_sessions_org"
    ON "impersonation_sessions"("organization_id","started_at");

CREATE TABLE "break_glass_sessions" (
    "id"                       UUID           NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id"            UUID           NOT NULL,
    -- Break-glass may target a specific org (viewing that org's PII) or
    -- be org-agnostic (platform-wide diagnostic).
    "target_organization_id"   UUID,
    "reason"                   TEXT           NOT NULL,
    "ticket_id"                TEXT           NOT NULL,
    "started_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"               TIMESTAMPTZ(6) NOT NULL,
    "ended_at"                 TIMESTAMPTZ(6),
    "ended_reason"             TEXT,
    "ip"                       INET,
    "user_agent"               TEXT,
    "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "break_glass_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "break_glass_sessions_actor_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "break_glass_sessions_org_fkey"
        FOREIGN KEY ("target_organization_id") REFERENCES "organizations"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "break_glass_sessions_reason_length"
        CHECK (char_length(reason) >= 5),
    CONSTRAINT "break_glass_sessions_ticket_length"
        CHECK (char_length(ticket_id) >= 1),
    CONSTRAINT "break_glass_sessions_expires_future"
        CHECK (expires_at > started_at)
);

CREATE INDEX "idx_break_glass_sessions_actor_active"
    ON "break_glass_sessions"("actor_user_id")
    WHERE "ended_at" IS NULL;
