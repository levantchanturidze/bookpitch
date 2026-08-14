-- =============================================================================
-- Production-grade email outbox: status machine, idempotency, concurrent-safe
-- claiming (FOR UPDATE SKIP LOCKED), exponential backoff, dead-letter.
--
-- Adds to the existing email_outbox table:
--   • idempotency_key — caller-supplied unique key (e.g. 'break_glass_alert:{id}')
--                       prevents duplicate alerts on retry.
--   • status          — explicit state: pending → processing → sent | dead
--   • next_attempt_at — exponential-backoff scheduling for retries
--   • max_attempts    — per-row cap (default 3, matches MAX_OUTBOX_ATTEMPTS)
--   • claim_owner     — worker ID that holds the current processing claim
--   • claim_expires_at — stale-claim recovery: reset to pending when past
--   • claimed_at      — when the claim was taken
--   • failure_category — structured failure tag (provider_error | config_error | unknown)
--
-- State transitions:
--   pending    → processing  (worker claims via FOR UPDATE SKIP LOCKED)
--   processing → sent        (send succeeds)
--   processing → pending     (send fails, attempts < max_attempts; next_attempt_at = backoff)
--   processing → dead        (send fails, attempts >= max_attempts)
--   processing → pending     (stale claim recovery: claim_expires_at < now())
--
-- Rollback:
--   ALTER TABLE email_outbox
--     DROP COLUMN IF EXISTS idempotency_key,
--     DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS next_attempt_at,
--     DROP COLUMN IF EXISTS max_attempts,
--     DROP COLUMN IF EXISTS claim_owner,
--     DROP COLUMN IF EXISTS claim_expires_at,
--     DROP COLUMN IF EXISTS claimed_at,
--     DROP COLUMN IF EXISTS failure_category;
--   DROP INDEX IF EXISTS idx_email_outbox_idempotency;
--   DROP INDEX IF EXISTS idx_email_outbox_worker;
--   CREATE INDEX idx_email_outbox_pending
--     ON email_outbox (created_at) WHERE sent_at IS NULL AND failed_at IS NULL;
-- =============================================================================

ALTER TABLE email_outbox
  ADD COLUMN idempotency_key  TEXT,
  ADD COLUMN status           TEXT        NOT NULL DEFAULT 'pending',
  ADD COLUMN next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN max_attempts     INT         NOT NULL DEFAULT 3,
  ADD COLUMN claim_owner      TEXT,
  ADD COLUMN claim_expires_at TIMESTAMPTZ,
  ADD COLUMN claimed_at       TIMESTAMPTZ,
  ADD COLUMN failure_category TEXT;

-- Migrate existing rows to the new status column.
UPDATE email_outbox SET status = 'sent'  WHERE sent_at   IS NOT NULL;
UPDATE email_outbox SET status = 'dead'  WHERE failed_at IS NOT NULL AND attempts >= 3 AND sent_at IS NULL;
-- Rows with failed_at but attempts < 3 were retryable — reset them.
UPDATE email_outbox SET status = 'pending', failed_at = NULL
  WHERE failed_at IS NOT NULL AND attempts < 3 AND sent_at IS NULL;

-- Sparse unique index on idempotency_key (NULLs are not constrained).
-- Prisma cannot express partial unique indexes; enforcement is DB-only.
CREATE UNIQUE INDEX idx_email_outbox_idempotency
  ON email_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Worker index: the drain query filters on status='pending' and next_attempt_at.
-- Replaces the old sent_at/failed_at partial index.
DROP INDEX IF EXISTS idx_email_outbox_pending;
CREATE INDEX idx_email_outbox_worker
  ON email_outbox (next_attempt_at ASC)
  WHERE status = 'pending';
