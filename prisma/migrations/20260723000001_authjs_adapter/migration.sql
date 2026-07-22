-- =============================================================================
-- Auth.js Prisma adapter — forward migration.
--
-- Adds the columns the standard adapter expects on the User table (which we
-- alias to our existing `app_users`) so we don't need two parallel user
-- tables. Adds `verification_tokens` for password-reset + magic-link
-- readiness. Non-destructive; existing rows keep working.
-- =============================================================================

-- New columns on app_users. All nullable so existing rows validate.
ALTER TABLE "app_users"
    ADD COLUMN "email_verified" TIMESTAMPTZ(6),
    ADD COLUMN "image"          TEXT,
    ADD COLUMN "name"           TEXT;

-- Backfill: mirror existing full_name into the new adapter-friendly `name`.
UPDATE "app_users" SET "name" = "full_name" WHERE "name" IS NULL AND "full_name" IS NOT NULL;

-- Adapter's password-reset + magic-link token store. Keys per Auth.js docs.
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token"      TEXT NOT NULL,
    "expires"    TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("token")
);
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key"
    ON "verification_tokens"("identifier", "token");

-- Grant the app role the same DML rights it already has on other tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "verification_tokens" TO bookpitch_app;
