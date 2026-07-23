-- Staff invitations. Owner creates an invitation; the invitee visits a URL
-- carrying the raw token, sets a password (or reuses an existing account),
-- and a Membership row is created for them in the inviter's org.
--
-- Design decisions:
-- - Token is stored as sha256 hex so a DB dump doesn't yield working links.
-- - status field so the audit trail is explicit (pending / accepted / revoked
--   / expired) instead of us deriving it from a nullable acceptedAt.
-- - RLS tenant_isolation policy scopes reads/writes to the inviting org.
-- - Invitee email + role are captured at invitation time; the invitee can't
--   escalate role by accepting.

CREATE TABLE "invitations" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "email"           CITEXT         NOT NULL,
    "role"            user_role      NOT NULL,
    "token_hash"      TEXT           NOT NULL,
    "expires_at"      TIMESTAMPTZ(6) NOT NULL,
    "status"          TEXT           NOT NULL DEFAULT 'pending'
        CHECK ("status" IN ('pending','accepted','revoked','expired')),
    "invited_by"      UUID,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "accepted_at"     TIMESTAMPTZ(6),
    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitations_token_unique" UNIQUE ("token_hash"),
    CONSTRAINT "invitations_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "invitations_invited_by_fk"
        FOREIGN KEY ("invited_by") REFERENCES "app_users"("id") ON DELETE SET NULL
);
CREATE INDEX "idx_invitations_org_status"
    ON "invitations" ("organization_id", "status");

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitations"
    USING       (organization_id = current_org_id())
    WITH CHECK  (organization_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "invitations" TO bookpitch_app;
