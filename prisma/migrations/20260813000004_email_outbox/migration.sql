-- =============================================================================
-- Transactional email outbox.
--
-- Rows are written inside the same transaction as the triggering event
-- (break-glass start, impersonation start) and drained by the housekeeping
-- cron. This ensures:
--   • No email is sent for a rolled-back event.
--   • A transient email-send failure does not silence a security alert.
--
-- Rollback:
--   DROP TABLE IF EXISTS email_outbox;
-- =============================================================================

CREATE TABLE email_outbox (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  to_address  TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  purpose     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  failed_at   TIMESTAMPTZ,
  attempts    INT         NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- Partial index: the drain query only needs to scan unsent, non-failed rows.
CREATE INDEX idx_email_outbox_pending
  ON email_outbox (created_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- Full-scan index on created_at (Prisma-visible, for housekeeping ORDER BY).
CREATE INDEX idx_email_outbox_created
  ON email_outbox (created_at);
