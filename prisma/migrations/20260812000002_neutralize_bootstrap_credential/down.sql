-- This migration is intentionally irreversible.
--
-- The compromised credential cannot and must not be restored. To re-establish
-- platform admin access, use the secure bootstrap command:
--   npx tsx scripts/platform-bootstrap.ts
--
-- Rolling back this migration would re-enable a known-compromised credential,
-- which is a security violation regardless of environment.
DO $$ BEGIN
  RAISE EXCEPTION 'neutralize_bootstrap_credential is intentionally irreversible — do not roll back';
END $$;
