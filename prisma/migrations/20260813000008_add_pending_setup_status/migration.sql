-- =============================================================================
-- Add 'pending_setup' to the organizations status allowed values.
--
-- This explicit lifecycle state represents an org that has been created but
-- not yet given its first owner/membership. It is exempt from the ORG_OWNER
-- invariant. Orgs in pending_setup must not have active tenant data.
--
-- Rollback: drop constraint and re-add without 'pending_setup'.
-- =============================================================================

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_status_check;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_status_check
    CHECK (status IN ('pending_setup', 'trial', 'active', 'suspended', 'archived'));
