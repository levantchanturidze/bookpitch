# RBAC — Handover status, August 2026

Written 2026-08-04 for the person picking this back up in three weeks.
Assumes nothing. Reads plainly and points at the code and commits.

## What this is

Bookpitch is a clinic and salon scheduling app: patients, appointments,
clinical notes, payments, waitlist, staff availability. Multi-tenant on
one Postgres database, so tenant isolation is not a nice-to-have — it's
the thing that determines whether one clinic can see another clinic's
patient list. RLS on the DB + a role/permission bundle in the app both
enforce it, and both are load-bearing. The spec is `docs/rbac-spec.md`;
the invariants that don't bend are in `CLAUDE.md`.

Three roles matter at the DB layer:

- **bookpitch_app** — the runtime application role. NOSUPERUSER,
  NOBYPASSRLS. Powers every tenant-scoped query via `withOrg(orgId, tx
  => ...)` which sets `app.current_org_id` inside a transaction; RLS
  filters by that value. This is the second layer of tenant isolation.
- **bookpitch_login** — narrow-grant role added for SEC-007. BYPASSRLS
  (necessary — `buildAuthContext` runs before org context exists) but
  SELECT grants on only eight auth-graph tables: `app_users`,
  `memberships`, `organizations`, `roles`, `role_permissions`,
  `membership_branches`, `impersonation_sessions`,
  `break_glass_sessions`. Any accidental query outside that set fails
  with `permission denied for table X` at Postgres — proven against
  prod, not just declared in a migration file.
- **postgres** — the DB superuser. Historically was the runtime admin
  connection (`unsafePrismaAdmin`); still used for platform-plane
  operations, system crons, DDL in `db-partitions` cron, Stripe
  webhook, and the login-lookup fallback until `DATABASE_URL_LOGIN`
  activates the narrow role. Every import of `unsafePrismaAdmin` is
  gated by an ESLint allowlist (`no-restricted-imports` in
  `eslint.config.mjs`) — new callers surface for review.

The environment-variable names are deliberately self-documenting:
`DATABASE_URL_APP_NOBYPASSRLS`, `DATABASE_URL_SUPERUSER_TXPOOL`,
`DATABASE_URL_SUPERUSER_SESSION`, `DATABASE_URL_SUPERUSER_MIGRATE`,
`DATABASE_URL_LOGIN`. The legacy names (`DATABASE_URL`,
`ADMIN_DATABASE_URL`, `ADMIN_RUNTIME_DATABASE_URL`,
`ADMIN_MIGRATE_DATABASE_URL`, `DIRECT_URL`) are still accepted as
fallbacks — SEC-007 was clear that names hiding privilege are a
documentation bug — but new deployments should use the new names. See
`.env.example` for the full reference and which role/privilege each
maps to.

## What is live and verified in production

Sign-in works end to end. Verified 2026-08-04 by a synthetic
credentials flow: CSRF token acquired, POST
`/api/auth/callback/credentials` returns 302 with a session cookie,
`/` redirects to `/platform`, and `/platform/orgs` renders. Role-aware
landing (F-10) routes SUPER_ADMIN to `/platform`, ACCOUNTANT to
`/analytics`, MARKETING to `/patients`, everyone else to
`/scheduler`.

The narrow bookpitch_login role is active. `/api/health` reports three
checks now — `DATABASE_URL` (runtime app role), `ADMIN_DATABASE_URL`
(superuser fallback), and `DATABASE_URL_LOGIN` (bookpitch_login). All
three green. The Vercel boot log line `db.prismaLogin.init` shows
`narrowRoleActive: true`, meaning every authenticated request now runs
its auth-context construction through bookpitch_login. Grants proven
by a `SET ROLE bookpitch_login` probe against prod: eight auth tables
ALLOWED, sixteen tenant tables (customers, treatment_history,
payments, audit_log, and more) DENIED. Full grant matrix in
`docs/rbac-security-review.md` § SEC-007.

RBAC enforcement is on globally. `RBAC_ENFORCE_MODULES=*` was set in
prod on 2026-08-02. Every `requirePermission` call now throws
`ForbiddenError` on deny (mapped to 403). Shadow-mode tolerance is
off. F-09 (the `:own`-scope list-mode gap that blocked PROVIDER
sign-in the first time we tried to flip enforcement) is closed —
`can()` grants a list-mode call when `:own` is the strongest scope,
and every list route that reads with an `:own` grant filters its
query by the caller's user id.

The security review probe suite is 58 tests, all `it(...)` (nothing on
`it.fails`), all green. Runs in ~1.5s. The logger tests are another
12 (added 2026-08-04 with the scrubPhi wire), also green. The suites
are at `tests/security-review.test.ts` and `tests/logger.test.ts`;
per-probe descriptions include which finding they regress-guard.

The append-only audit_log invariant holds. BEFORE UPDATE, BEFORE
DELETE, and BEFORE TRUNCATE triggers on the parent + every partition,
plus REVOKE UPDATE, DELETE on bookpitch_app. Attempted UPDATE from
either role fails at Postgres; TRUNCATE fails via trigger. Probes
P4.1 through P4.8 exercise every arm.

Break-glass reads are audited fail-closed. `withPlatformApi` now
throws when the audit-write inside a break-glass session fails,
instead of the previous silent-swallow. SEC-003 fix. Spec §7.2 rule 6
holds literally: a break-glass read that cannot be audited is never
served.

Feature-toggle changes are audited. The
`PATCH /api/platform/orgs/[id]/toggles` route writes an
`org.toggles.update` audit row with the previous and next OrgToggles
in the `meta` JSON — SEC-004 fix. Before this, an
`org.providerClinicalNotesOthers = true` flip persisted with zero
evidence.

Impersonation cannot flip clinical-visibility toggles.
`platform.config.manage` is on `RESTRICTED_DURING_IMPERSONATION` —
SEC-005 fix. Closes the two-step clinical exfiltration path.

The last SUPER_ADMIN cannot be demoted. `assignPlatformRole` counts
active SUPER_ADMIN rows other than the target before allowing a
demote or revoke — SEC-006 fix. Rejects with a message telling the
operator to grant SUPER_ADMIN to another user first.

Logger output is scrubbed. `scrubPhi` runs unconditionally inside
`emit()` in `lib/logger.ts`. Keys in the exact list `PHI_KEY_NAMES`
(email, phone, dob, address, customerName / patientName / clientName /
fullName in camel and snake case, allergies, clinicalNotes, plus auth
secrets like password / passwordHash / token / accessToken /
refreshToken / apiKey / authSecret) get their values replaced with
`[redacted]` before the JSON line goes to stdout. Operational `*Name`
keys (serviceName, organizationName, providerName, staffName, roleName,
hostname) pass through — the previous broad `/name/i` pattern stripped
those too, destroying triage. See the sweep report and the "known
limitations" section below for what is not covered.

The F-06 migration workflow is wired but has a stale secret (see open
items). When it fails, it now opens or comments on a labeled GitHub
issue titled `[urgent] Migration workflow failed` — the fact that
F-06 silently failed on every run for a week before anyone noticed
was in the same category as the sign-in-dead-while-tests-passed
incident, so failure notification is now part of the workflow itself,
not an external monitor.

## Two operator actions still open

**One:** `DATABASE_URL_SUPERUSER_MIGRATE` GitHub Actions secret is
stale. The workflow reads it fine — the value has the wrong postgres
password. Rotate the postgres role's password (via Supabase
dashboard's Reset Database Password action AND `ALTER USER
bookpitch_app WITH PASSWORD '...'` in the SQL editor — the dashboard
reset only touches postgres, not bookpitch_app, and that mismatch
started F-12), then update the following env vars everywhere with the
new password:

- `DATABASE_URL_SUPERUSER_MIGRATE` — GitHub → Settings → Secrets and
  variables → Actions
- `ADMIN_DATABASE_URL` and `DATABASE_URL_SUPERUSER_SESSION` on Vercel
  Production and Preview
- Local `.env.supabase` and `.env.local` for anyone whose dev flow
  uses them
- `DATABASE_URL` on Vercel (uses bookpitch_app credentials, different
  role — needs its own password rotation from the SQL editor step
  above, then updated the same way)

After that, trigger the workflow with `gh workflow run migrate.yml
--repo levantchanturidze/bookpitch --ref main`. Any future failure
opens a GH issue automatically. Zero pending migrations right now —
`_prisma_migrations` in prod has all 34 rows including the SEC-007
bookpitch_login role migration, with correct SHA-256 checksums —
`prisma migrate deploy` will be a no-op the first time it runs
cleanly.

**Two:** `DATABASE_URL_SUPERUSER_TXPOOL` on Vercel had the wrong
value. When it was set on 2026-08-04, `/api/health` returned `28P01
password authentication failed` on the admin side within seconds —
prod was degraded. Per the standing revert-first rule I removed the
env var immediately, health recovered on fallback to
`ADMIN_DATABASE_URL`. Root cause is probably one of two things:
either the password in the value was stale (see item one), or the
Supabase transaction-pool endpoint requires the username to be
`postgres.<project-ref>` rather than `postgres` — the tx-pool port
uses different auth from the direct port. When re-adding, use exactly
this shape:

    postgresql://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1

Note the six things: `postgres.<project-ref>` username (not bare
`postgres`), the `pooler.supabase.com` subdomain (not `db.`), port
`6543` (not `5432`), `pgbouncer=true` and `connection_limit=1` on the
query string, and the current postgres password. Set on both
Production and Preview. After redeploy, `/api/health` should report
`DATABASE_URL_SUPERUSER_TXPOOL` as the admin-side key instead of
`ADMIN_DATABASE_URL`. Once that's live, the concurrency probe against
nested `withOrg` under transaction pooling can finally run — the
local session-pool probe (P7.4 in the security suite) passes and I
believe the shape carries over, but that's a belief, not proof.

## The fallback removal in lib/db.ts

`prismaLogin` in `lib/db.ts` currently falls back to `unsafePrismaAdmin`
when `DATABASE_URL_LOGIN` is unset or blank. That's deliberate — it
made the SEC-007 code safe to ship without operator coordination.
Once `DATABASE_URL_LOGIN` has been active in production for a week
without incident, remove the fallback so a missing env var becomes a
startup failure rather than a silent regression to the wide-blast-
radius superuser client. The change is a three-line delete around
`const LOGIN_URL = ...` and the ternary that follows. Keep the trim/
blank check — an accidentally-empty value should still be an error,
not fall through.

## What remains from the original phase plan and what was skipped

The phase plan was through Phase 7 (adversarial security review) plus
the post-launch findings backlog F-01 through F-12. Every P0 and P1
finding is either closed or reduced to a documented operator action.
The remaining backlog items are these:

The subscription and billing write side (F-08 sub-item). The read-only
`BillingPanel` on `OrgDetail` ships plan / planStatus / renewal
window / Stripe customer + subscription deep-links. Write ops
(checkout, plan change, cancellation, webhook mapping) need the
Stripe SDK wired up and `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
in Vercel. Neither is a Bookpitch decision — you need to pick a
Stripe account, generate the keys, decide which price IDs map to
which internal plan tier. Half a day of work once the keys are in
hand.

Value-level PII scrubbing in the logger. `scrubPhi` catches keys on
its list, not values embedded inside string values. A Twilio or
Postmark error like `Delivery failed to +995551234567` written into a
`log.warn('sms.failed', { error: err.message })` still surfaces the
phone number verbatim because the key is `error`, not `phone`. The
right fix isn't in the logger — value-level regex scrubbing is
fragile. The right fix is at the error boundary in `mapError`
(`lib/auth.ts`) and each provider-catch call: normalize `err.message`
to strip URLs, `DETAIL: Key (...) = (...)` clauses, and E.164 phone
patterns before it's passed into `log.error`. Documented in
`tests/logger.test.ts` as the "KNOWN LIMITATION" case.

Real-path integration tests for the rest of the auth surface. F-05
partial fix landed a validateCredentials integration test. Similar
tests for org-switch, invitation accept, and password-reset request
would raise the confidence bar further. Not urgent given the security
probe suite covers the boundaries.

A recurring drift probe for the migration workflow. Right now, if
someone manually runs `CREATE ROLE ...` in the Supabase SQL editor
that isn't reflected in `_prisma_migrations`, the migration workflow's
post-apply `prisma migrate status` check would catch it on the next
push. That's reactive. A scheduled `migrate status` cron would catch
it within an hour of the manual mutation. Small addition when it's
worth it.

The `bookpitch_login` role's password rotation is on the operator, not
the code. There's no automated rotation — that's a deliberate call
because rotation with a live prod requires coordination with the
Vercel env var update in the same window.

## The three incidents and the rules that came out of them

**F-12 (2026-08-02).** During the DB-password rotation session,
diagnostic work included a `while … case …` loop over `.env.supabase`
intending to filter values out. The fall-through arm echoed every
unmatched line verbatim into the conversation transcript, including
`AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`, `CRON_SECRET`,
`PAYMENT_MOCK_SECRET`, and both database passwords. All had to be
rotated. Rule (now in `CLAUDE.md`): never echo, cat, grep, or loop
over a file containing secrets. Read into a variable and pipe via
stdin. Redirect any output that could contain a credential. Rotation
scripts do not live in the repo — extract-then-delete. Sensitive
Vercel env vars are one-way: they cannot be read back via API or
CLI, so every local file holding those values must be updated at
rotation time or the next session starts blocked. Supabase's
dashboard Reset Database Password only rotates postgres — bookpitch_app
needs a separate `ALTER USER bookpitch_app WITH PASSWORD` in the SQL
editor. Missing that leaves a leaked credential live.

**F-06 silent workflow failure (2026-07-28 through 2026-08-04).** The
migration workflow (`.github/workflows/migrate.yml`) started failing
the moment it was written and continued failing on every run for a
week. Nobody noticed because there was no notification path — GH
Actions failure emails were either filtered out or never routed
anywhere useful. Same class of failure as the earlier incident where
tests passed while sign-in was dead. Rule: every scheduled workflow
that touches production must open (or comment on) a labeled GitHub
issue on failure. That step is now in `migrate.yml` itself — no
external Slack dependency, uses only `GITHUB_TOKEN` which is
automatically available. The failure mode is now loud without any
external plumbing to keep in sync. If you add another prod-facing
scheduled workflow, copy the pattern.

**Tx-pool activation degraded prod (2026-08-04).** `DATABASE_URL_SUPERUSER_TXPOOL`
was set on Vercel with a value that failed auth. `/api/health` showed
`28P01` on the admin side and every `unsafePrismaAdmin` query started
500'ing. The revert-first rule (documented in this session) says: if
a config change specifically degrades prod, remove the config so the
fallback takes over, confirm recovery, THEN diagnose. Don't try to
fix the config in place while prod is down. It cost about five
minutes end to end because the fallback was working. Corollary: any
env var whose set-but-broken state is worse than unset-and-fallback
needs an explicit fallback path in the code AND a revert-first
protocol in the operator runbook. `prismaLogin`'s trim/blank check is
the code-level version of this.

## The security review probe suite

Everything under `tests/security-review.test.ts`. Runs in ~1.5s. Do
not remove any probe — each one is a regression canary for a specific
finding. The `it.fails` marker is available for known-open findings
so CI stays green; there are zero `it.fails` right now. Adding a
finding means writing a probe that asserts SAFE behavior; if the
probe fails, the finding is real and gets tracked (with an entry in
`docs/rbac-security-review.md`) until it's fixed and the probe
starts passing.

The delta from the original 2026-07-29 review is at the bottom of the
security-review doc. Every SEC-# finding SEC-001 through SEC-007 has
a section explaining what it was, what shipped as the fix, and the
probe number that guards against regression.
