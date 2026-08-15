-- =============================================================================
-- Encrypt to_address (recipient email) in email_outbox at rest.
--
-- WHY: storing plaintext email addresses in the outbox means any DB dump or
-- leaked backup reveals recipient PII.  We apply the same AES-256-GCM scheme
-- used for body encryption (lib/crypto.ts encryptField).
--
-- COLUMNS:
--   to_address_encrypted  BOOLEAN NOT NULL DEFAULT false
--       True when to_address contains ciphertext (v1:<key-id>:<base64>).
--       False for legacy rows and test fixtures that store plaintext.
--
--   to_address_hash  TEXT
--       SHA-256 hex digest of the lowercase plaintext address.
--       Required for WHERE filtering (cancellation, dedup) on encrypted rows.
--       NULL for rows created before this migration (legacy plaintext rows
--       can still be filtered by the plaintext to_address column).
--
-- Drain paths (housekeeping + immediate) decrypt before calling provider.send
-- when to_address_encrypted = true; plaintext rows are used as-is.
--
-- Rollback:
--   ALTER TABLE email_outbox DROP COLUMN to_address_encrypted;
--   ALTER TABLE email_outbox DROP COLUMN to_address_hash;
-- =============================================================================

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS to_address_encrypted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS to_address_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_email_outbox_to_address_hash
  ON email_outbox (to_address_hash)
  WHERE to_address_hash IS NOT NULL;
