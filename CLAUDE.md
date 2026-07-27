@AGENTS.md
# Bookpitch — RBAC Rules

Specification: `docs/rbac-spec.md`. Read it before touching auth, permissions,
organizations, memberships, or any query that reads tenant-scoped data.

## Invariants — these do not bend

1. **Tenant isolation is checked first.** Every query touching tenant data
   filters by `organization_id`. A query without it is a bug regardless of
   what the surrounding code appears to guarantee.
2. **Fail closed.** Unknown permission key, missing membership, null org
   context, suspended organization → deny. Never fall through to allow.
3. **The audit log is append-only.** No UPDATE, no DELETE, no exceptions,
   including for SUPER_ADMIN. Enforced in the database, not in application code.
4. **No privilege escalation.** Nobody grants a role at or above their own rank,
   or modifies a member at or above their own rank.
5. **Every organization keeps at least one active ORG_OWNER.** Removing the
   last one fails.
6. **Admins never set passwords.** Reset links only, rate limited.
7. **Permissions live in the database.** Roles are bundles of permission rows.
   Adding a permission must not require a code change or a redeploy.
8. **SUPER_ADMIN has no permission ceiling**, but reaching client PII or
   clinical records goes through break-glass: reason, re-authentication,
   60-minute expiry, audited reads. See spec §7.2.

## Working rules

- Never weaken, skip, or delete a test to make a build pass. If a test blocks
  you, the test is telling you something — surface it.
- Never bypass a guard "temporarily." If something cannot be built within these
  invariants, stop and say so. That is a useful answer.
- If a change spans more than ~5 files, show the plan before writing.
- Every migration is reversible and has a written rollback.
- Where the spec is ambiguous or contradicts existing code, stop and ask.
  Do not silently pick an interpretation.
- Write findings to `docs/` as you go. Anything not written down is lost at the
  next context reset.
