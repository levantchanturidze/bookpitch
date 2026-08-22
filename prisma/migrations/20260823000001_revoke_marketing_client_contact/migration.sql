-- F16-012 — MARKETING no longer reads patient contact details.
--
-- The seeded MARKETING bundle was (client.read:contact, report.own,
-- report.branch). client.read:contact reaches the patients surface and, through
-- it, every patient's name, email, phone and date of birth. That is a marketing
-- role reading identifiable patient contact data in a clinical product, granted
-- by default and never separately justified.
--
-- Least privilege: the two reporting grants stay, so aggregate, non-identifying
-- analytics is unaffected. Nothing is granted in exchange — a campaign that
-- genuinely needs contact data needs its own permission with a stated purpose,
-- consent/opt-out handling, minimum-necessary fields and an audit trail. See
-- docs/phase-16-reconciliation-ledger.md (F16-012).
--
-- Additive and idempotent: it deletes at most one row, and re-running is a
-- no-op. The original seed migration is left exactly as applied — history is
-- not rewritten — so a clean install grants the row and this removes it.
--
-- ROLLBACK
--   INSERT INTO role_permissions (role_id, permission_key)
--   SELECT r.id, 'client.read:contact'
--   FROM roles r
--   WHERE r.key = 'MARKETING' AND r.organization_id IS NULL
--   ON CONFLICT DO NOTHING;
--
--   Restoring it re-grants patient contact access to every MARKETING member in
--   every organization. Do not run it to "unblock" someone.

DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.key = 'MARKETING'
  AND r.organization_id IS NULL
  AND rp.permission_key = 'client.read:contact';
