-- =============================================================================
-- Add body_encrypted flag to email_outbox.
--
-- Sensitive emails (verification links, recovery codes) must not store
-- plaintext tokens in the outbox body. When body_encrypted = true, the body
-- column contains AES-256-GCM ciphertext produced by encryptField() in
-- lib/platform/mfa.ts. The housekeeping drain decrypts before sending.
--
-- Default false preserves backward compatibility for existing rows.
-- All new application-created rows with sensitive payloads set this to true.
--
-- Rollback: ALTER TABLE email_outbox DROP COLUMN body_encrypted.
-- =============================================================================

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS body_encrypted BOOLEAN NOT NULL DEFAULT false;
