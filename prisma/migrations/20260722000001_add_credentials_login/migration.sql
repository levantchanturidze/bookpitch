-- Add password_hash for the Auth.js Credentials provider.
-- Nullable so future SSO users (Google, Clerk, etc.) can co-exist.
ALTER TABLE "app_users" ADD COLUMN "password_hash" TEXT;

-- Emails must be unique across the whole auth system.
CREATE UNIQUE INDEX "app_users_email_key" ON "app_users"("email");
