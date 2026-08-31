# Phase 17 — Stabilization ledger

Working branch `agent/phase-17-stabilization`, cut from `main` at `5c8fb77`.

Phase 17 is a stabilization phase: no new product features, and no deferred
scope implemented to satisfy a checker. Everything below is a defect fixed, a
control made observable, or a claim replaced with a measurement.

---

## 0. Baseline at `5c8fb77`

| | |
|---|---|
| Branch / HEAD | `main` @ `5c8fb77`, clean tree |
| Node / npm | v24.16.0 / 11.13.0 |
| Next / React | 16.3.0 / 19.2.4 |
| Prisma (cli / client) | 7.9.1 / 7.9.0 |
| Playwright / Vitest / TypeScript | 1.61.1 / 4.1.10 / 5.9.3 |
| `@sentry/nextjs` | 10.67.0, installed |
| Migrations | 62 |
| Prisma models | 35 |
| Seeded permissions | 67 |
| Unit + integration suite | 86 files, 1055 tests, all passing (35.15s) |
| Guard checker | 105 entry points, 18 allow-listed, all guarded |
| Production | `bookpitch.ge`, deployment `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG` = SHA `5c8fb77`, `/api/health` 200 |
| GitHub Actions | **billing-suspended** since 2026-08-22 |

### The Phase 16 branch is not on main

Several findings in the Phase 17 brief are stated against a tree that is not
`main`. Phase 16 is 23 commits frozen at `14f7c26` on the local-only branch
`agent/phase-16-prepilot-product-refinement`, in a separate worktree at
`/Users/levan/Desktop/VS/bookpitch-phase16` — unpushed, unmerged, with its own
September integration checklist.

Phase 17 therefore targets `main`, which is what is deployed. Where a finding
does not reproduce at `main`, it is recorded as such rather than "fixed".

### GitHub Actions is suspended

Every scheduled run since 2026-08-22 fails before starting:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

Consequences that matter when reading this document: **CI has not run**, the
production monitor is not running, and the scheduled crons are not firing — so
nothing is draining `email_outbox` in production right now. Every result below
is `LOCALLY VERIFIED`. None of it is CI-verified.

---

## 1. Findings revalidated against `5c8fb77`

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| §5 | MARKETING lands on an unauthorized `/patients` | **NOT REPRODUCIBLE** | MARKETING still holds `client.read:contact` in both `prisma/rbac-seed.ts` and migration `20260810000006`, and `/patients` requires exactly that. The revocation exists only on the frozen Phase 16 branch (migration `20260823000001_revoke_marketing_client_contact`), which does not touch the landing. |
| §7 | The signup journey is silently excluded | **CONFIRMED, and worse** | `ci.yml` ran `--grep "@a11y\|@responsive"`; `e2e/signup-scheduler.spec.ts` carried no tag. It had also gone stale — it waited for `/signin` after signup, but signup has redirected to `/onboard/pending` since email verification landed. It would have failed had it ever run. |
| §10 | Sentry is a no-op in production | **CONFIRMED, and worse** | `vercel env ls production`: both `*_ENVIRONMENT` names set, neither DSN present. `next.config.ts` has no `withSentryConfig` and there was no `instrumentation-client.ts`, so the browser config was never bundled — and importing it **failed the build** (§4). |
| §14 | Password reset swallows delivery failure | **CONFIRMED** | `lib/auth/password-reset.ts:65-77` — direct `provider.send()`, `catch → log.warn`, route answers 202. |
| §15 | Three delivery paths | **CONFIRMED** | Durable outbox used by onboarding, break-glass, impersonation, MFA, audit digest. Direct `provider.send()` in password reset, invitations, ownership transfer, reminders. |
| §17 | Provider HTTP inside an open transaction | **CONFIRMED** | `sendForAppointment` wrapped everything in `withoutRls` = `$transaction`; `provider.send()` ran inside it. |
| §18 | Unbounded cron fan-out | **CONFIRMED** | `Promise.all(orgs.map(...))` with no `take` in both cron routes; `PG_POOL_MAX` absent in production → default 3. |
| §19 | Deny-list references counted as enforcement | **CONFIRMED, five keys not four** | `org.delete`, `platform.billing.manage`, `clinical_note.create`, `clinical_note.attachment.manage`, **and `clinical_note.read:own`**. |
| §20/21 | Permission accounting | **CONFIRMED + one INCONSISTENT** | 20 keys tagged `notYetImplemented`, guard printed 19 — `platform.billing.manage` was simultaneously deferred and counted enforced, and was silently dropped from the deferred tally. |
| §22 | Exactly 100 `audit_log` rows | **INVESTIGATED — §8** | |
| §23 | Stale documentation | **CONFIRMED, five claims** | §9. |

---

## 2. P17-006 — permission accounting

`scripts/check-orphan-perms.ts` matched `perm('x')` textually, so entries in
`RESTRICTED_DURING_IMPERSONATION` counted as enforcement. Appearing in a **deny**
list is the opposite of being enforced. It also read comments as code
(`lib/rbac/guard.ts` documents its own signature in a docstring;
`lib/rbac/toggles.ts` names three keys in JSDoc) and **missed** real callsites,
because `can\(\s*[a-zA-Z_$]+\s*,` requires a bare identifier — hiding
`can(v.ctx, 'clinical_note.read:any', …)` in `lib/customers.ts`, which is the
actual enforcement point for the clinical tier.

It now parses with the TypeScript compiler. A reference counts only when the key
is passed to something that asks whether the caller holds it:
`requirePermission()`, `can()`, or `ctx.{permissions,platformPermissions}.has()`.

Scope resolution mirrors `can()` rather than approximating it: the four scope
suffixes resolve from a base key, the five tier suffixes match exactly. That is
what previously hid `client.read:basic` and `clinical_note.read:own` in the
enforced column.

### Recomputed from HEAD

| Classification | Count |
|---|---|
| Seeded | **67** |
| ENFORCED | **40** |
| EXPLICITLY_DEFERRED | **27** |
| ORPHAN / UNACCOUNTED | **0** |
| INCONSISTENT | **0** |

Seven permissions moved from a false "enforced" to explicitly deferred, each
tagged with why. **All seven fail closed** — every one denies a holder rather
than admitting one — so this corrects the accounting, not a privilege boundary:

| Key | Bundle | Why it gates nothing |
|---|---|---|
| `client.read:basic` | `client_read_basic_tier` | `client.read:contact` is the enforced floor; a `:basic`-only holder is denied outright |
| `clinical_note.create` | `clinical_notes` | no table, no endpoint |
| `clinical_note.read:own` | `clinical_notes` | `decideFullAccess` checks `:any`, never `:own` |
| `clinical_note.attachment.manage` | `clinical_note_attachments` | no table, no endpoint |
| `report.financial:org` | `report_financial_tier` | `/analytics` gates on `report.branch`; nothing reads the financial tier |
| `org.settings.update:branch` | `branch_scoped_org_settings` | every settings surface passes `:org` whole |
| `org.delete` | `org_self_delete` | no org-plane self-delete endpoint; deletion is platform-plane |

`platform.billing.manage` stays **explicitly deferred**, which is correct: no
platform billing UI or endpoint exists, and Phase 17 did not build one to
satisfy a checker.

`tests/orphan-perms-model.test.ts` pins both claims the checker makes — the
scope/tier model against `can()` itself, and "deny lists and comments are not
enforcement" against a scan of the real tree — each with a complement case that
must fail classification, so neither can pass by returning nothing.

---

## 3. P17-001 — the role landing contract

`app/page.tsx` chose a destination with a switch whose reasoning lived in
comments. The mapping now lives in `lib/rbac/landing.ts` as data, and
`tests/role-landing.test.ts` evaluates it against the permissions actually
seeded in the database, through `can()`, asking each destination's own question.

`LANDING_PERMISSION` is checked against the `requirePermission` call in the page
source, so the contract cannot rot back into a comment. The `default:` arm is
gone — a role with no landing goes to `/signin` rather than to a page we already
know it cannot open — and `CLIENT` is recorded explicitly as having no staff-app
landing.

Two things pinned that nothing previously checked:

- **Every platform role must hold `platform.analytics.read`.**
  `app/platform/layout.tsx` redirects `ForbiddenError` to `/`, and `/` sends
  platform roles to `/platform`. A platform role without that permission is an
  infinite redirect, not a 403. All four hold it today.
- **The Phase 16 revocation now trips a test.** Applying it to a local database
  makes `tests/role-landing.test.ts` fail with `MARKETING lands on /patients but
  lacks client.read:contact` (1 failed | 20 passed). MARKETING retains
  `report.branch`, confirming `/analytics` as the correct destination at that
  point. Revocation reverted; 21/21 passing again.

---

## 4. P17-007 — observability

Production had the SDK installed, three config files, `instrumentation.ts`
exporting `onRequestError`, and both `*_ENVIRONMENT` variables set — with no
DSN. Every `Sentry.init()` sits inside `if (…_DSN)`, so the stack was a no-op.

The browser half was not merely unconfigured; it was **unbuildable**.
`sentry.client.config.ts` imported `sentryBeforeSend` from `lib/logger.ts`,
whose first line is `import { AsyncLocalStorage } from 'node:async_hooks'`.
Wiring it up fails `next build`:

```
the chunking context (unknown) does not support external modules
(request: node:async_hooks)
```

Anyone who had added `withSentryConfig` would have hit this on their first
build. `lib/scrub.ts` now holds the pure half — sensitive-key set,
`looksLikeSecret`, `scrubSensitive`, `sanitizeErrorMessage` — with no imports at
all, and `lib/logger.ts` re-exports it, so one scrubber serves both sides and a
PHI key added there is redacted in the browser too.

Client init goes through `instrumentation-client.ts`, the framework convention
(Next 15.3+), which also works under Turbopack where the SDK's webpack discovery
does not apply.

### The import is guarded, and that is measured

| Build | gzipped client JS |
|---|---|
| No browser Sentry at all | 395,521 |
| Static `import './sentry.client.config'` | 458,764 |
| Guarded dynamic import, DSN unset | Sentry chunk emitted but in **no page entry graph** — never fetched |

A static import costs **63,243 bytes gzipped on every page load**, including the
public booking widget, whether or not a DSN exists. The cost of the guard is
that Next's docs call async work in this file fire-and-forget, so an error in the
first few milliseconds can be missed. That is the right trade for 61 KB.

### What was proven, level by level

`npm run verify:sentry` reports four levels and exits non-zero below level 4. It
is proven to discriminate, not merely to run: against a local ingest stub
answering `200` it reports level 4; against the same stub answering `403` it
reports level 3 and refuses to call Sentry operational.

| Level | Production status |
|---|---|
| 1 CONFIGURED | **FAIL** — no DSN exists |
| 2 INITIALISED | not reachable |
| 3 EMITTED | not reachable |
| 4 RECEIVED | not reachable |

**Production Sentry: NOT VERIFIED at any level.** The exact external action is
to create the Sentry project and set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`.
Source-map upload is a second, separate gap needing `withSentryConfig` plus
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`.

Blindness is now counted: `config.missingObservabilityEnv` feeds monitor check
`production-observability-unconfigured`, deliberately separate from
`production-config-incomplete` — "we cannot see it break" and "it is broken"
sharing one status line means the first gets read as the second.

---

## 5. P17-004 / P17-005 — reminders and cron fan-out

`sendForAppointment` held a Postgres transaction open across `provider.send()`,
and `RateLimit.messaging()` opened a **second** transaction on the other pool
from inside it. With `PG_POOL_MAX` defaulting to 3 and unset in production,
three slow reminders starve both pools.

Delivery is now five phases; only the short ones are transactional. The claim
step takes `FOR UPDATE` on the appointment and re-checks for a duplicate under
that lock.

### Measured against the old implementation

Running `tests/phase17-reminder-boundary.test.ts` against
`git show main:lib/messaging/reminders.ts` — four failures:

- the appointment row **is** locked during the SMS provider call
- …and during the email provider call
- …and during a deliberately slow one
- two concurrent sends returned `['sent','sent']`

That last one is not theoretical. **The customer received two messages.** Dedup
was check-then-insert at READ COMMITTED with no unique constraint on
`(appointment_id, channel)` and no row lock, so a cron tick and an operator
pressing "Send now" could both pass the check. It is now
`['sent','skipped_duplicate']`.

A CONTROL test holds the lock deliberately and requires the probe to detect it,
so the boundary tests cannot pass by failing to measure anything.

Cron fan-out is bounded at `cronOrgConcurrency()` — default 2, clamped to
`PG_POOL_MAX` — and settles instead of racing, so one failing organization is
reported and the rest still finish. Raising `PG_POOL_MAX` was deliberately not
the fix: it moves the ceiling to Supabase's pooler, shared with every other
connection.

---

## 6. P17-002 / P17-003 — durable transactional email

Password reset and invitations both called `provider.send()` inside a try/catch
that logged a warning and returned. For password reset the route then answered
202 "if the address exists, we sent a link", so when the provider was down the
email did not exist anywhere.

Both now go through `lib/messaging/outbox.ts`, the durable path that onboarding,
break-glass, impersonation, MFA and the audit digest already used. The five
existing callers are deliberately untouched — they work and have tests, and
rewriting break-glass or MFA delivery during a stabilization phase buys nothing.

Security properties preserved and asserted: enumeration safety, encryption at
rest for body and recipient, the token never reaching the logs, a retry
re-sending the **same** link rather than minting a second credential, and only
one live reset token at a time. New: a second reset request marks the first
still-queued email `dead` with `failure_category='superseded'`, so a user cannot
receive a link that the same request just invalidated.

Terminal failures land in `dead`, which `lib/ops-metrics.ts` already counts and
the production monitor already alarms on — the dead-letter test asserts that
number moves, not just that a row changed status.

---

## 7. P17-009 to P17-013 — the authenticated E2E foundation

### What was broken

CI ran `playwright test --grep "@a11y|@responsive"`. A positive grep is a silent
allowlist: the untagged signup journey was excluded from every run and nothing
reported that a critical journey had stopped executing.

### What replaced it

Every project declares its own `testMatch`, so a spec is either claimed by a
project or it runs nowhere, and `npm run e2e:check` fails the build if any
required project reported zero tests. Tags remain in titles for humans; they no
longer decide what runs.

`e2e/auth.setup.ts` signs in once per role through the real `/signin` form and
saves storage state. Nine identities — eight org-plane roles plus
`PLATFORM_ADMIN` — seeded by `scripts/seed-e2e-users.ts` into the existing dev
organisation so the surfaces actually render. `SUPER_ADMIN` is deliberately not
used: it has MFA enabled, and weakening that to make a test convenient is the
opposite of the point.

### The test-only Turnstile credential

`lib/auth/e2e-runtime.ts` is one gate: `E2E_TURNSTILE_BYPASS_TOKEN` at least 32
characters, an exact constant-time match, and `APP_URL` on loopback.

The guard is APP_URL, deliberately **not** `NODE_ENV`. `next start` sets
NODE_ENV=production, which is when the suite runs, so a NODE_ENV guard would be
one the tests themselves had to defeat — and a guard the test suite defeats is
not a guard. Production's `APP_URL` is `https://bookpitch.ge`, so even a leaked
variable plus the correct token is refused.

`tests/phase17-turnstile-bypass.test.ts` walks the matrix, including the case
that matters most — production-shaped `APP_URL` with the variable set and the
token correct — and requires a refusal. `lib/onboarding.ts::resolveAppUrl` keys
its HTTPS/no-localhost relaxation off the same gate.

### Renaming the projects silently disabled two tests

Worth recording because it is the same class of defect as the original.
`e2e/accessibility.spec.ts` branched on `testInfo.project.name === 'webkit'` and
`name.startsWith('mobile')`. Renaming the projects to `public-webkit` and
`public-mobile-safari` made the first comparison stop matching — so a WebKit run
began asserting Chromium tab order — and the second skip condition inverted, so
the touch-target test skipped on **every** project including the mobile ones.
Both now match on substring.

### The first run found four real defects

None of these were visible to any previous test.

1. **Shadow mode makes every denial test vacuous.** With `RBAC_ENFORCE_MODULES`
   unset, `requirePermission` only logs `rbac.shadow_deny` and lets the request
   through. Measured: MARKETING reached `/scheduler` and `/audit`, and ORG_OWNER
   reached `/platform/orgs`. The Playwright web server now pins `'*'`, and one
   dedicated test fails with that explanation rather than four confusing ones.

2. **Signup was unreachable in a production-mode build for two more reasons**
   beyond the CAPTCHA: `RATE_LIMIT_HMAC_KEY` and `EMAIL_PRIVACY_HMAC_KEY` refuse
   to fall back in production (500 before any logic under test), and
   `resolveAppUrl()` rejects a loopback HTTP origin. Both are correct production
   behaviour; the suite now supplies a production-shaped environment.

3. **Horizontal overflow on every authenticated page at 320px** — WCAG 1.4.10
   (Reflow). The existing `@responsive` suite only covered signed-out pages.

   | Surface | Before | After |
   |---|---|---|
   | `/scheduler` | 82px | **0px** |
   | `/patients` | 24px | **0px** |
   | `/analytics` | 24px | **0px** |
   | Access Locked state | 82px | **0px** |

   Two root causes, both fixed in `components/shell/Shell.tsx` and
   `components/scheduler/SchedulerView.tsx`: the header's left group would not
   shrink, pushing the notification bell and user menu 24px off-screen on every
   page; and the scheduler's month navigator and status legend did not wrap.

4. **P17-013 — the "Access Locked" panel never renders in production.**
   See below.

### P17-013 — KNOWN GAP, not fixed in Phase 17

`app/(app)/error.tsx` dispatches on `error.name === 'ForbiddenError'`. Next.js
strips the name and message from errors forwarded to the client in production
builds, documented at
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:106`.
Only `digest` survives, and it is a hash, not a type.

Measured against `next start`: MARKETING opening `/scheduler` gets HTTP 500,
`rbac.enforce_deny` in the server log, and the generic "Something went wrong"
fallback. **The refusal is correct and no tenant data leaks** — the user is
simply told the wrong thing.

The fix is not a patch in that file: the client cannot recover the error type.
It is Next's `forbidden()` plus a `forbidden.tsx` boundary, which requires
`experimental.authInterrupts` and a change at every guard callsite. That is a
redesign, not a stabilization change, so it is recorded here for Phase 18 rather
than rushed in at the end of a phase.

---

## 8. P17-014 — the 100-row `audit_log` observation: NOT A DEFECT

Investigated read-only against the production database on 2026-08-23
(`SET default_transaction_read_only = on`; SELECT only; counts and dates only).

**The count is 100 because 100 audited actions have happened, and production has
been idle since.** There is no cap, no trim and no truncated query.

| Evidence | Value | What it rules out |
|---|---|---|
| Total rows | 100 | — |
| `id` range | **2 → 103**, span 102, rows 100 | A cap would leave contiguous ids and trim the oldest. Two ids are missing mid-range — ordinary sequence burn from rolled-back transactions. |
| First / last row | 2026-07-24 → **2026-08-15** | Nothing has been audited for the eight days before this investigation. |
| Rows per day | 6, 4, 1, 2, 9, 9, 6, 21, 10, 14, 17, 1 | Irregular and summing to 100 by coincidence. A cap produces a flat edge, not this. |
| Append-only triggers | `audit_log_no_delete`, `audit_log_no_update`, `audit_log_no_truncate` all present | Nothing *could* have removed rows, including the superuser. |
| Live table sizes | 10 orgs, 16 users, **3 appointments, 2 customers, 0 outbox rows** | A pre-pilot system with almost no activity. |

The "exactly 100 twice" observation resolves the same way: both restore drills in
`docs/phase-13-production-reliability-ledger.md` (lines 282 and 558) ran **after**
the last audit write on 2026-08-15, so two different backups necessarily captured
the same frozen 100 rows.

Corroborating: `scripts/backup-production.sh` is a full `pg_dump` with no row
limits, `scripts/restore-verify.sql:122` is a plain `count(*)`, and
`lib/audit-query.ts` defaults to `take: 200`. None of the three could produce a
100.

**No retention policy was changed**, per the brief's instruction not to alter one
without a proven defect.

---

## 9. Documentation reconciled

`docs/features-en.md` claims contradicted by the code at `5c8fb77`:

| Claim | Reality |
|---|---|
| "Ownership-transfer UI absent" | `app/(app)/settings/ownership/` + `components/settings/OwnershipPanel.tsx` |
| "there is no 'add insurer' UI" | `AddInsurerForm` in `app/(app)/settings/insurance/InsuranceView.tsx` |
| "no export button exists on the audit viewer" | "Export CSV" at `components/audit/AuditView.tsx:70` |
| "break-glass 2FA — implementation is password-only" | `lib/platform/break-glass.ts` requires `totpCode` or `recoveryCode`; contradicted by line 185 of the same document |
| "The Sentry SDK is not installed" | `@sentry/nextjs` 10.67.0 is a dependency |

Historical reports are left historically accurate; only current-status claims
are corrected.

---

## 10. Also observed, not acted on

`prisma/rbac-seed.ts` contains **four literal NUL bytes** — a separator written
as a raw byte rather than an escape. `file(1)` reports the authoritative
permission seed as `data`, and `grep` skips it as binary unless given `-a`. Any
grep-based tooling over this repository — including the gitleaks secret scan —
silently misses this file. Cosmetic to fix, but worth knowing before trusting a
repo-wide grep.

---

## 11. Test evidence

Exact commands and results, all on `agent/phase-17-stabilization`.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **PASS** (0 errors) |
| ESLint | `npx eslint .` | **PASS** (0 errors; 58 pre-existing warnings, unchanged in kind) |
| Formatting | `npx prettier --check .` | **PASS** |
| Unit + integration | `npx vitest run` | **1157/1157 passing, 92 files** (baseline 1055 / 86) |
| Guard checker | `npm run test:guards` | **PASS** — 105 entry points, 18 allow-listed, all guarded |
| Orphan permissions | `npm run check:orphan-perms` | **PASS** — 67 = 40 enforced + 27 deferred, 0 orphan, 0 inconsistent |
| Playwright | `npm run e2e` | **240 passed, 3 skipped, 0 failed** (243 total, 9 projects, 38.3s) |
| E2E coverage guard | `npm run e2e:check` | **PASS** — all 9 required suites executed |
| Prisma schema | `npx prisma validate` | **PASS** |
| Clean install | `prisma migrate deploy` into an empty database | **PASS** — 62 applied, 0 unfinished, 47 tables |
| Schema drift | `prisma migrate diff --from-migrations --to-schema --exit-code` | **PASS** — "No difference detected", exit 0 |

The three Playwright skips are the touch-target check on the three non-mobile
projects, which is its intended condition.

### Security suites, run explicitly

`rbac-rls`, `rls`, `db-role-grants`, `platform-mfa`, `platform-break-glass`,
`platform-impersonation`, `phase12-owner-invariant`, `platform-password-reauth`,
`rate-limit`, `onboard-turnstile`, `security-review`, `security-logging`,
`crypto-rotation`, `password-reset`, `platform-audit` — **334/334 passing across
15 files**.

### Clean-install security invariants, verified on a disposable database

| Invariant | Observed |
|---|---|
| Migrations applied / unfinished | 62 / 0 |
| RLS enabled / FORCE RLS | 21 / 21 tables |
| audit_log append-only triggers | `audit_log_no_delete`, `audit_log_no_update`, `audit_log_no_truncate` |
| `bookpitch_app` (rolsuper, rolbypassrls) | `false,false` |
| `bookpitch_app` UPDATE on `audit_log` | `f` |

Both disposable databases were dropped afterwards.

---

## 12. Security regression check

**No migration was added, edited or removed.** `git diff --stat main --
prisma/migrations` is empty; the count is still 62.

`git diff --name-only main` touches these security-relevant paths and no others:
`lib/rbac/landing.ts` (new, additive), `app/page.tsx`, `app/api/onboard/route.ts`,
`lib/onboarding.ts`, `lib/auth/password-reset.ts`, `lib/auth/e2e-runtime.ts`
(new), `lib/messaging/*`, `lib/invitations.ts`, `lib/logger.ts`, `lib/scrub.ts`,
`lib/ops-metrics.ts`, `app/(app)/error.tsx`, `app/(auth)/signup/SignupForm.tsx`.

**Untouched:** `auth.ts`, `auth.config.ts`, `proxy.ts`, `next.config.ts`,
`prisma/schema.prisma`, all of `lib/platform/`, and every file in `lib/rbac/`
except the new `landing.ts`.

| Control | Status | Basis |
|---|---|---|
| Tenant isolation / FORCE RLS | intact | 21/21 FORCE RLS on clean install; `rbac-rls` + `rls` suites pass; no policy touched |
| Ownership invariant | intact | `phase12-owner-invariant` passes; the E2E cleanup was rewritten *because* the invariant refused to bend |
| MFA | intact | `platform-mfa` passes; `lib/platform/mfa.ts` untouched; the E2E suite uses PLATFORM_ADMIN rather than weakening the MFA-enabled SUPER_ADMIN |
| Break-glass second factor | intact | `platform-break-glass` passes; `lib/platform/break-glass.ts` untouched |
| Impersonation restrictions | intact | `RESTRICTED_DURING_IMPERSONATION` unchanged. P17-006 changed only how the *checker* reads it, not what `can()` does with it |
| Session-purpose binding / reauth | intact | `platform-password-reauth` passes; those paths untouched |
| Rate limiting | intact | `rate-limit` passes. `RateLimit.messaging()` moved out of the reminder transaction; the limit, bucket and ordering relative to dedup are unchanged |
| Turnstile | **strengthened in test, unchanged in production** | One additional accepted credential, gated on a loopback APP_URL. `tests/phase17-turnstile-bypass.test.ts` requires a refusal for production-shaped configuration, including the leaked-variable case |
| Safe redirects | intact | `app/page.tsx` now returns to `/signin` instead of guessing a destination — strictly more conservative |
| CSRF | intact | `auth.config.ts` and `proxy.ts` untouched |
| Password-reset enumeration safety | intact | route still answers 202 unconditionally; an unknown address queues nothing, asserted in `tests/phase17-durable-transactional-email.test.ts` |
| Field encryption | intact | `lib/crypto.ts` untouched. Reset and invitation bodies are now encrypted at rest, which is more coverage, not less |
| Audit logging | intact | append-only triggers verified on clean install; no audit write path changed |

One control is newly *observable* rather than newly enforced: a missing Sentry
DSN now trips `production-observability-unconfigured` instead of passing silently.

---

## 13. Production verification

Separated deliberately, because three of these are not the same claim.

### Locally verified
Everything in §11.

### CI verified
**Nothing.** GitHub Actions has been billing-suspended since 2026-08-22; jobs
report `steps=0` and never start. `npm run e2e` and every static check above ran
on this machine. **CI has not run and must not be reported as passing.**

### Deployment verified
`bookpitch.ge` serves deployment `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG`, SHA
`5c8fb77`, Ready 2026-08-22T18:32:42Z — the deployment carrying the corrected
`FIELD_ENCRYPTION_KEY`. `GET /api/health` returns 200 `{"ok":true}` and `/signup`
returns 200 with its heading rendered. Phase 17's own commits are **not**
deployed; this branch has not been pushed.

### Production runtime verified — onboarding: **NOT PRODUCTION VERIFIED**

The reason is specific, and it is not "we forgot".

Read-only against the production database on 2026-08-23:

| | |
|---|---|
| Ciphertext rows, all six encrypted locations | **0** |
| `pending_registrations` | **0** |
| `email_outbox` | **0**, no rows in any status |
| Newest `app_users` / `organizations` / `appointments` | all **2026-08-12** |
| Newest `audit_log` row | **2026-08-15** |

**The encryption path has not executed in production since the key was corrected
on 2026-08-22.** There is no evidence either way because nothing has happened —
not a signup, not a user, not a queued email.

It cannot be probed synthetically either:

- `POST /api/onboard` requires a real Turnstile solve. The E2E credential is
  refused there by design — production's `APP_URL` is `https://bookpitch.ge`, and
  that is the whole point of the gate.
- `GET /api/health/ops` returns **401** with the CRON_SECRET available locally,
  so `config.invalidSecurityEnv` and the ciphertext counts cannot be read from
  the application either. (`.env.supabase`'s copy is stale, as the Phase 15
  record already noted.)
- The production monitor, which would answer this every 30 minutes, is not
  running — same Actions suspension.

Any one of three external actions would settle it: a real browser signup (which
creates a permanent organisation, because the resulting audit rows cannot be
deleted), restoring the production `CRON_SECRET` locally so `/api/health/ops`
can be read, or restoring Actions billing so the monitor resumes.

### Production runtime verified — Sentry: **NOT VERIFIED at any level**
No DSN exists. See §4.

---

## 14. Remaining risks

### P0
None identified.

### P1
- **Sentry is unconfigured in production.** Every uncaught server, edge and
  browser exception is discarded. The code is now complete and the gap is
  counted by the monitor, but the DSN is an external action (§4).
- **P17-013 — the Access Locked panel never renders in production.** The refusal
  is correct and leaks nothing; the user is told "Something went wrong" instead
  of why. Needs `forbidden()` + `experimental.authInterrupts` (§7).
- **P17-008 — housekeeping deletes live tokens on a non-UTC Postgres session.**
  Production Supabase is UTC so production is unaffected. Already fixed on the
  frozen Phase 16 branch by `00577db`; the risk is that Phase 16 merges partially
  (§6).
- **GitHub Actions billing.** No CI, no production monitor, no crons. Nothing is
  draining `email_outbox` in production — currently harmless only because it is
  empty.

### P2
- **No source-map upload**, so production stack traces will point at minified
  code once a DSN exists. Needs `withSentryConfig` + `SENTRY_AUTH_TOKEN`.
- **Five durable-email callers still hand-roll the enqueue/drain pattern**
  (onboarding, break-glass, impersonation, MFA, audit digest). They work and are
  tested; consolidating them onto `lib/messaging/outbox.ts` is tidying, not a fix.
- **`lib/admin/ownership-transfer.ts` still sends directly** and swallows the
  failure. Lower stakes than reset or invitations — the nominee also gets an
  in-app notification, and the transfer row exists regardless.
- **Four NUL bytes in `prisma/rbac-seed.ts`** make the authoritative permission
  seed invisible to `grep` and to the gitleaks scan (§10).
- **E2E signup artifacts accumulate** in a long-lived development database, since
  an audited organisation can only be archived, not deleted. Harmless in CI,
  where the database is ephemeral.

### Deferred product scope, unchanged
Clinical notes and attachments, payment refunds, shift close, staff commission,
rooms/resources, block-time, integrations, platform billing UI, payroll and
own-tier reports all remain explicitly deferred and correctly classified. Phase
17 built none of them to satisfy a checker.

---

## 15. Recommendation for Phase 18

In this order, because the first two unblock the ability to verify the rest:

1. **Restore GitHub Actions billing.** Nothing here is CI-verified, the
   production monitor is dark, and no cron has run since 2026-08-22. This is the
   single largest gap in the evidence, and it is not a code problem.
2. **Provision the Sentry DSN** and run `npm run verify:sentry` against
   production until it reports level 4. Then decide on source maps.
3. **Merge Phase 16** using its own September integration checklist. Two Phase 17
   guards are waiting for it: `tests/role-landing.test.ts` will fail on the
   MARKETING landing the moment the revocation lands, and F16-010 fixes the
   housekeeping clock defect reproduced in §6.
4. **Fix P17-013** with `forbidden()` — a real redesign of the denial path, worth
   its own scope rather than a corner of a stabilization phase.
5. **Then, and only then, verify production onboarding**, once the monitor is
   running and can observe it rather than requiring a synthetic org that cannot
   be deleted.
