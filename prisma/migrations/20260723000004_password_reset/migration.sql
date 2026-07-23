-- Password reset flow + session revocation.
--
-- session_version is bumped every time a user's password is changed. The
-- Auth.js jwt() callback embeds the current version in the token; the
-- session() callback compares against the DB (with a small in-process
-- cache) and returns null if they diverge — old JWTs get evicted.
--
-- Reset tokens live in the existing verification_tokens table (identifier =
-- user email, token = single-use, expires = short-lived).

ALTER TABLE "app_users"
    ADD COLUMN "session_version" INT NOT NULL DEFAULT 1;
