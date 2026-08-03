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

## Secret handling — hard rule (F-12, 2026-08-02 incident)

- Never echo, cat, grep, or loop over a file containing secrets. Read into a
  variable and pipe via stdin. Redirect any output that could contain a
  credential. This has caused an incident; treat it as a hard rule.
- Consequences that follow: parse `.env*` files with a language that has
  proper string handling (Python, Node); extract only what you need; print
  keys only. Never `cat .env.local | grep KEY`. Never a `while … case …` loop
  over env-file lines. Never `--value <VALUE>` on a CLI that has a stdin path.
- Sensitive Vercel env vars are one-way: they cannot be read back via API or
  CLI. Every local file holding those values must be updated at rotation
  time, or the next session starts blocked. Rotation scripts do not live in
  the repo — delete them after use.
- Supabase's dashboard "Reset database password" only rotates the `postgres`
  role. `bookpitch_app` (the runtime NOBYPASSRLS role, used by
  `DATABASE_URL`) needs a separate `ALTER USER bookpitch_app WITH PASSWORD`
  in the SQL editor. Missing this leaves a leaked credential live.
