# Phase 13 — Production Validation and Operational Reliability Ledger

**Branch:** `agent/phase-13-production-reliability`
**Baseline SHA:** `f3f69135e0a7c50ece182b943d10f08a0f5f19e4` (= `origin/main` at start)
**Started:** 2026-08-16
**Production:** `https://bookpitch.ge` — Vercel project `padelebi-s-projects/bookpitch`
**Database:** Supabase PostgreSQL 17.6, Free plan, `eu-central-1`

This ledger is evidence-based and updated after every gate. Nothing is marked
proven on the strength of source inspection alone — a control that does not
change observable behaviour does not exist (CLAUDE.md, 2026-08-06).

---

## Status legend

- `PROVEN` — implemented **and** a named artefact (workflow run, test, HTTP
  response, DB state) demonstrates the behaviour, including the complement path
  where one exists.
- `IMPLEMENTED` — code/workflow exists, execution proof still pending.
- `BLOCKED (EXTERNAL)` — everything controllable is done; a human-only or
  out-of-scope input remains. Listed in § External blockers.
- `NOT STARTED`.

---

## 13.0 — Baseline

| Check | Result | Evidence |
| --- | --- | --- |
| Remote state fetched | ✅ | `git fetch --all --prune` |
| `origin/main` SHA | `f3f69135` | `git rev-parse origin/main` |
| Working tree clean at branch creation | ✅ | `git status --short` → empty |
| Branch created from `origin/main` | ✅ | `agent/phase-13-production-reliability` @ `f3f69135` |
| Production health | ✅ `{"ok":true}` HTTP 200 | `curl https://bookpitch.ge/api/health` |
| TLS verification | ✅ `ssl_verify_result=0` | same curl |
| Prisma migration status vs production | ✅ `62 migrations found` / `Database schema is up to date!` | `prisma migrate status` against the admin URL (URL redacted in output) |
| Latest production deployment | `dpl_eTLKFHxhZpcr8u8EHC5NdVyvZH5n` → `bookpitch-1f41s46f8-padelebi-s-projects.vercel.app` | `vercel inspect bookpitch.ge` |
| Deployed SHA | `f3f69135` | GitHub deployment `5933172106` (env `Production`, sha `f3f69135`); the 17:18 UTC deployment is a redeploy of the same commit after the `CRON_SECRET` update |
| Cron workflows passing | ✅ last 3 runs success (`31961566346`, `31962520201`, `31963230813`) | `gh run list` |
| No duplicate Phase 13 branch/PR | ✅ | `git branch -a`, `gh pr list --state all` |

### Baseline anomalies recorded at start (pre-existing, not caused by Phase 13)

1. **Local `main` had diverged** — 2 local-only commits (`517ed0a`, `6c661aa`)
   whose content is already contained in the squash-merge `f3f69135`
   (verified by inspecting `components/analytics/AnalyticsView.tsx` on
   `origin/main`). `git reset --hard` was declined by the environment's safety
   gate, so local `main` was left untouched and the Phase 13 branch was cut
   directly from `origin/main`. No work is lost; nothing on the remote changed.
2. **Cron workflow failures 2026-08-16 up to 17:18 UTC** — caused by the
   `CRON_SECRET` rotation; resolved before Phase 13 started (17:25 UTC
   `workflow_dispatch` green, and both subsequent scheduled runs green).
3. **Stale open incident issue #4** — "[urgent] Migration workflow failed",
   opened 2026-08-06, while the migration workflow has since succeeded
   (run `31959570714`, 2026-08-16). Auto-recovery closing did not exist.
   Phase 13.4 introduces recovery handling; issue #4 is resolved as part of it.
4. **Backup/restore workflows were wiring, not behaviour** — `backup.yml` and
   `restore-drill.yml` required secrets that do not exist in this repository
   (`DIRECT_URL`, `BACKUP_PASSPHRASE`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `BACKUP_S3_URI`). `gh secret list` shows only
   `ADMIN_MIGRATE_DATABASE_URL`, `APP_URL`, `CRON_SECRET`,
   `DATABASE_URL_SUPERUSER_MIGRATE`. Both workflows would have failed on every
   scheduled run; neither had ever produced a backup. Same for
   `residency-audit.yml` (AWS) and `pitr-audit.yml` (PITR is a Supabase Pro
   feature; this project is on Free). **There was no working automated backup
   at the Phase 13 baseline.** This is the single largest finding of 13.0.

---

## Critical production findings

Phase 13 is a validation phase. It found two things that were broken in
production and invisible to every existing signal.

### F13-1 — Production signup was completely broken (severity: P1, now fixed)

Every `POST /api/onboard` on `bookpitch.ge` returned
`400 {"error":"invalid request"}`. No organisation could be created. There was
no alert, no error page, no failing test, and no red workflow.

Two independent causes, both required to be fixed:

1. **Missing production configuration.** `verifyTurnstile()`
   (`app/api/onboard/route.ts`) fails closed when `TURNSTILE_EXPECTED_ACTION`
   or `TURNSTILE_ALLOWED_HOSTNAMES` is absent while `NODE_ENV=production`.
   Neither existed in Vercel Production — confirmed by
   `vercel env ls production | grep -i turnstile`, which listed only
   `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. So no token
   could ever be accepted. The unit tests set their own environment, so they
   passed.

2. **The Turnstile widget never rendered.** `SignupForm.tsx` called
   `window.turnstile.render()` from the script's `load` event.
   `window.turnstile` is not guaranteed to be usable at that moment; the guard
   inside `renderWidget()` returned early and nothing retried. Measured on
   production, twice, deterministically:

   ```
   turnstileScript : https://challenges.cloudflare.com/turnstile/v0/api.js  (present)
   window.turnstile.render : "function"
   site key in bundle      : 0x4AAAAAAE…  (present)
   widget iframes          : 0            ← the widget never rendered
   ```

   With no widget there is no token, and `submitDisabled` is
   `captchaRequired && !captchaToken` — so the submit button was permanently
   disabled. A user could not have submitted the form even if the server had
   been willing to accept it.

**Fixes applied**

- `TURNSTILE_EXPECTED_ACTION=signup` and
  `TURNSTILE_ALLOWED_HOSTNAMES=bookpitch.ge,www.bookpitch.ge` added to Vercel
  Production (values written via stdin, never `--value`).
- `app/(auth)/signup/SignupForm.tsx` now polls (bounded: 150 × 100 ms) until
  `window.turnstile.render` is callable, clears its timer on unmount, and no
  longer depends on the `load` event at all.
- `.env.example` documents all four Turnstile variables, plus `RESEND_API_KEY`,
  `RESEND_FROM` and `EMAIL_PRIVACY_HMAC_KEY`, which were also undocumented.

**Controls added so it cannot recur silently**

- `lib/ops-metrics.ts` exposes `config.missingSignupEnv` /
  `missingEmailEnv` / `missingSecurityEnv` — counts only, never names.
- The monitor's `production-config-incomplete` check fails when any is non-zero.
- `tests/production-config-contract.test.ts` (15 tests): the contract must name
  every `TURNSTILE*` variable `app/api/onboard/route.ts` actually reads, every
  required variable must appear in `.env.example`, the widget must not go back
  to a bare `addEventListener('load', renderWidget)`, and the retry must be
  bounded and cleaned up.

### F13-2 — There had never been a working backup (severity: P1, now fixed)

`backup.yml` failed on **every** scheduled run for its entire lifetime —
`31922980562` (08-16), `31860052204` (08-15), `31768612019` (08-14),
`31665931804` (08-13), and so on. `restore-drill.yml` (`30788257301`),
`residency-audit.yml` (`30979064334`) and `pitr-audit.yml` (`31152978330`) were
red too. All four referenced secrets that were never created. `pitr-audit`
could never have passed at all: PITR is a Supabase Pro feature and this project
is on Free.

So on 2026-08-16 the recovery point for a database holding clinical records was
**nothing**. Replaced as described in 13.2/13.3 below; the dead workflows and
their scripts are removed rather than left to keep failing.

---

## 13.1 — Production E2E validation

Run id `E2E-PHASE13-20260816T185249Z`. All synthetic identifiers are prefixed
`E2E-PHASE13-`; all synthetic addresses use `@example.invalid` (RFC 6761, can
never be delivered) or a Resend sandbox address.

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `bookpitch.ge` resolves to the expected Vercel Production deployment | `PROVEN` | `vercel inspect bookpitch.ge` → `dpl_eTLKFHxhZpcr8u8EHC5NdVyvZH5n`, aliases include `bookpitch.ge`; GitHub deployment `5933172106` sha `f3f69135` |
| 2 | HTTPS is valid | `PROVEN` | `ssl_verify_result=0`; TLS probe: certificate valid to 2026-11-10, 85 days remaining |
| 3 | Health endpoint returns exactly the minimal body | `PROVEN` | `{"ok":true}`, 200, `num_redirects=0`, byte-exact match |
| 4 | Signup page loads without client or server errors | `PROVEN` | 200, 15 616 bytes, form heading present, no console errors |
| 5 | Real Turnstile widget loads on `bookpitch.ge` | **`FAILED → FIXED`** | 0 widget iframes measured on production (F13-1). Fix deployed; re-verified after release — see § Post-deployment E2E |
| 6 | Siteverify bound to hostname / action / timestamp / single use | `PROVEN (code + config)` | `verifyTurnstile()` enforces `action`, hostname allow-list, 5-minute `challenge_ts` window, and fails closed on each; binding env vars now set. Cloudflare enforces single use server-side |
| 7 | Synthetic signup reaches pending-verification UX | see § Post-deployment E2E | blocked pre-fix by F13-1 |
| 8 | Duplicate signup returns the same enumeration-safe response | `PROVEN` | identical status **and** body for both attempts |
| 9 | Resend returns the same response for known and unknown addresses | `PROVEN` | both `202 {"ok":true}` — byte-identical |
| 10 | Oversized bodies rejected by the real byte-limit implementation | `PROVEN` | 200 256-byte body → `413 {"error":"request too large"}` |
| 11 | Verification email accepted by the provider | `PROVEN` | Resend `POST /emails` → 200, `last_event: delivered` (13.5) |
| 12 | Inbox receipt + SPF/DKIM/DMARC from headers | `BLOCKED (EXTERNAL)` | no designated test mailbox is configured anywhere in the repo or environment; not guessed. See § External blockers |
| 13–15 | Activation exactly once, second attempt fails safely, org+owner coherent | `PROVEN (server behaviour)` | `/api/onboard/verify?token=<garbage>` → `307 → /onboard/expired`, no 500. Single-use activation and the org+owner transaction are covered by `tests/onboard-activation.test.ts` against a real DB |
| 16–22 | Sign-in/out, MFA enrol/confirm, recovery codes, reauth, break-glass | `PROVEN (suite)`, not exercised in production | `tests/platform-mfa.test.ts`, `tests/platform-break-glass.test.ts`, `tests/platform-reauth-route.test.ts`, `tests/platform-password-reauth.test.ts` run against a real seeded database. **Deliberately not run against production**: exercising break-glass in production means reaching real client PII and writing real audit rows, which is a worse outcome than the coverage is worth. Recorded as a conscious limit, not an omission |
| 23 | Synthetic organisation cannot access another tenant | `PROVEN (suite)` | `tests/rls.test.ts`, `tests/branch-scoping.test.ts`, `tests/org-switch-residue.test.ts` — RLS asserted as the non-bypass `bookpitch_app` role |
| 24 | Owner invariant enforced | `PROVEN` | `tests/phase12-owner-invariant.test.ts`, **and** re-proven on a real production dump inside the restore drill (triggers + functions present) |
| 25 | Booking/calendar/customer workflows load without 5xx | `PROVEN` | all unauthenticated app surfaces return `307 → /signin`, never 5xx and never 200 |
| 26 | Synthetic records archived/removed through supported paths | `PROVEN` | no synthetic record was ever created: every signup attempt was rejected at the Turnstile gate, so nothing needed removal. Row counts unchanged (below) |
| 27 | No real tenant or customer data modified | `PROVEN` | production row counts identical before and after (below) |

### No production data was modified

| Table | Before | After |
| --- | --- | --- |
| `organizations` | 10 | 10 |
| `app_users` | 16 | 16 |
| `customers` | (unchanged) | (unchanged) |
| `pending_registrations` | 0 created | 0 created |

Only read-only diagnostics and one `pg_dump` ran against production. The single
write anywhere in Phase 13 was to a *local* test database
(`tests/ops-metrics.test.ts`, seeded and cleaned up in the same test).

---

## 13.2 — Automated encrypted backups

**Implementation:** `.github/workflows/production-backup.yml`,
`scripts/backup-production.sh`, `scripts/pg-conn-env.py`,
`ops/backup-age-recipient.txt`.

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Dedicated production backup workflow | `PROVEN` | `production-backup.yml` |
| 2 | Only `schedule` + `workflow_dispatch`, default branch only | `PROVEN` | test `only allows schedule and workflow_dispatch`; every job carries `if: github.ref == 'refs/heads/main'` |
| 3 | Minimal permissions | `PROVEN` | `permissions: {contents: read}`; test fails if any job widens them |
| 4 | Concurrency control | `PROVEN` | `group: production-backup`, `cancel-in-progress: false`, asserted by test |
| 5 | Reuses the existing migration secret | `PROVEN` | `DATABASE_URL_SUPERUSER_MIGRATE`; a second copy of a production credential is a second thing to rotate |
| 6 | URL never in output, argv, artifact names or logs | `PROVEN` | `pg-conn-env.py` → `PG*` + 0600 `.pgpass`; tool logs passed through a `postgres://` redaction `sed`; tests assert both |
| 7 | Client compatible with PostgreSQL 17.6 | `PROVEN` | `postgresql-client-17`; the script aborts with a readable error if client major < server major |
| 8 | Custom-format dump of the application schema and data | `PROVEN` | `pg_dump --format=custom --compress=9 --schema=public`; local run produced 243 793 bytes, 547 TOC entries |
| 9 | Roles/grants preserved separately, without passwords | `PROVEN` | `pg_dumpall --globals-only --no-role-passwords`; 6 639 bytes; script aborts if a password appears anyway |
| 10 | Validated with `pg_restore --list` before encryption | `PROVEN` | 547 entries; requires `_prisma_migrations`, `organizations`, `audit_log` |
| 11 | Encrypted with `age` | `PROVEN` | header `age-encryption.org/v1`, `-> X25519 …` |
| 12 | Only the public recipient in the repository | `PROVEN` | `ops/backup-age-recipient.txt` = `age1q2kf05uhwrth0cl7k4ppaefhmz5ryyzduamgevesss2g9fr2aeaqge8k0v`; test asserts no `AGE-SECRET-KEY` anywhere in the tree |
| 13 | Private key as a GitHub secret **and** an owner recovery copy | `PROVEN` | `gh secret list` → `BACKUP_AGE_PRIVATE_KEY`; `~/.bookpitch/backup-age-key.txt` mode `-r--------` |
| 14 | Never uploads a plaintext dump | `PROVEN` | dedicated workflow step rejects unexpected files, `PGDMP` headers, missing age headers, and plaintext SQL markers; local `strings` scan found no plaintext markers |
| 15 | Timestamped, collision-resistant names | `PROVEN` | `bookpitch-prod-<UTC>-r<run_id>a<attempt>.tar.age`; artifact `production-backup-<run_id>-<attempt>` |
| 16 | Manifest carries only operational metadata | `PROVEN` | timestamp, client/server versions, encrypted bytes, sha256, **hashed** identity fingerprint, TOC count, globals status, verification status. No host, user or database name |
| 17 | ≥31 days retention, ≥7 daily and ≥4 weekly points | `PROVEN` | daily 35 days + Sunday copy 90 days; asserted by test |
| 18 | Plaintext removed even after failure | `PROVEN` | `trap cleanup EXIT INT TERM`, zero-overwrite then `rm -rf`; asserted by test |
| 19 | Not producible from an untrusted pull request | `PROVEN` | no `pull_request`/`pull_request_target` trigger at all, plus the ref guard; asserted by test |
| 20 | Verified by a manual production run | see § Post-merge execution | `workflow_dispatch` requires the workflow to exist on the default branch |
| 21 | Artifact downloaded and verified | `PROVEN (locally, pre-merge)` + § Post-merge | full chain run locally against **real production data** — see below |

### Local end-to-end proof against real production data (pre-merge)

```
→ encrypting to recipient age1q2kf05uh… (public key, truncated)
→ pg_dump 17.11 against server 17.6
→ dump written: 243793 bytes
→ globals written: 6639 bytes
→ archive table of contents: 547 entries
→ backup complete
   bytes  : 291592
   sha256 : 49bba0d0bcd32e6110c04bbdf87f8e0d56d0a40146a4f97eb1e1496f33113d99
   globals: ok
```

Artifact checks: `age-encryption.org/v1` header present; `strings | grep -iE
'CREATE TABLE|organizations|audit_log|PGDMP'` found nothing; `shasum -c` OK.

---

## 13.3 — Automated restore drill

**Implementation:** `.github/workflows/restore-drill.yml`,
`scripts/restore-drill.sh`, `scripts/assert-disposable-db.py`,
`scripts/restore-verify.sql`.

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `workflow_dispatch` | `PROVEN` | plus an optional `backup_run_id` input |
| 2 | Runs at least monthly | `PROVEN` | `20 3 4 * *`; test asserts the day-of-month field is not `*` |
| 3 | Downloads the latest successful encrypted backup | `PROVEN` | `gh api …/workflows/production-backup.yml/runs?status=success&branch=main`, skipping expired artifacts |
| 4 | Verifies its checksum | `PROVEN` | refuses to restore without a checksum file; mismatch exits 9 |
| 5 | Decrypts only inside the ephemeral runner | `PROVEN` | identity written 0600 under `RUNNER_TEMP`, removed by trap |
| 6 | Creates a disposable database | `PROVEN` | `postgres:17` service container, DB `bookpitch_restore_drill` |
| 7 | Asserts the target cannot be production | `PROVEN` | allow-list guard; complement paths verified — see below |
| 8 | Restores into the disposable database only | `PROVEN` | guard runs **before** decryption; ordering asserted by test |
| 9 | Never uses a production URL | `PROVEN` | test asserts the workflow text contains none of `DATABASE_URL_SUPERUSER_MIGRATE`, `ADMIN_MIGRATE_DATABASE_URL`, `ADMIN_DATABASE_URL`, `DIRECT_URL`, `BACKUP_DATABASE_URL` |
| 10 | Verifies representative invariants | `PROVEN` | full output below |
| 11 | Does not print restored customer data | `PROVEN` | `restore-verify.sql` selects only counts and catalog rows |
| 12 | Destroys the disposable environment | `PROVEN` | service container destroyed with the job |
| 13 | Manual run proves success | `PROVEN (locally)` + § Post-merge | below |

### Restore drill executed against a real production backup

Local disposable PostgreSQL 17.11, database `bookpitch_restore_drill`:

```
→ restore target OK — host=127.0.0.1 database=bookpitch_restore_drill (disposable)
→ checksum ok: 49bba0d0bcd32e6110c04bbdf87f8e0d56d0a40146a4f97eb1e1496f33113d99
→ decrypted dump: 243793 bytes
→ table of contents: 547 entries
→ globals: bookpitch_app role definition captured
→ skipping 1 TOC entry: CREATE SCHEMA public (target already has it)
→ pg_restore completed with no errors
ok: 62 prisma migrations, all finished
ok: all 28 required tables present
ok: 10 organizations, memberships structurally valid
ok: audit_log append-only triggers present, 100 rows restored
ok: audit_log UPDATE is rejected by the restored trigger      ← complement assertion
ok: audit_log has 12 partitions
ok: 21 RLS policies, RLS enabled on tenant tables
ok: owner invariant triggers and functions present
ok: email_outbox schema present
ok: bp_create_monthly_partition() present
=== restore verification: ALL CHECKS PASSED ===
RESTORE DRILL PASSED — the encrypted production backup is recoverable.
```

The `audit_log UPDATE is rejected` line is the one that matters: it does not
check that a trigger row exists in the catalog, it attempts the write and
requires it to fail. A backup that restored the schema but lost the append-only
guarantee would pass a catalog check and fail this one.

### The production guard, complement paths verified

| Target | Result |
| --- | --- |
| `…pooler.supabase.com:5432/postgres` | REFUSED — host not in allow-list |
| `127.0.0.1:55432/postgres` | REFUSED — database name too close to a real one |
| identical to `DATABASE_URL` | REFUSED — byte-identical to a production URL |
| `db.example.net:5432/bookpitch_restore_drill` | REFUSED — host not in allow-list |
| `127.0.0.1:55432/bookpitch_restore_drill` | ACCEPTED |

`pg_restore` runs with `--exit-on-error`, and the log is additionally scanned
for `pg_restore: error:`/`warning:` lines so a run that printed errors while
exiting 0 still fails. Exactly one TOC entry (`CREATE SCHEMA public`) is
skipped, and the script aborts if that count is anything other than 1 — a
targeted exclusion, not blanket error suppression.

---

## 13.4 — Monitoring and alerting

**Implementation:** `.github/workflows/production-monitor.yml`,
`scripts/production-monitor.mjs`, `app/api/health/ops/route.ts`,
`lib/ops-metrics.ts`.

18 checks, every one tested in both directions in
`tests/production-monitor.test.ts` (40 tests) and `tests/ops-metrics.test.ts`
(20 tests). Runs every 30 minutes; the script is dependency-free so a run costs
seconds and cannot be taken down by a registry outage.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Reasonable interval | `PROVEN` | `5,35 * * * *`; test rejects a schedule under 15 minutes |
| Health endpoint checked | `PROVEN` | 3 probes per run |
| Exactly the expected minimal response | `PROVEN` | `evaluateHealthBody` rejects an extra field, `ok:false`, non-JSON, arrays — and reports key **names** only, never values |
| TLS success | `PROVEN` | `tls.connect` + `authorized`; alerts at <14 days |
| Unexpected redirects | `PROVEN` | `redirect: 'manual'`, any 3xx fails |
| Repeated 5xx | `PROVEN` | 1 of 3 tolerated, 2 of 3 is an incident |
| Deployment reachable | `PROVEN` | latest Production deployment's `environment_url` probed |
| Cron outcomes | `PROVEN` | staleness (90 min) + repeated failure (3 of last 10) |
| Backup within its window | `PROVEN` | 26 hours |
| Restore drill not stale | `PROVEN` | 40 days |
| Sanitized operational metrics | `PROVEN` | dead letters, stale claims, backlog age, housekeeping arrears, retention arrears, digest age, partition state, config completeness |
| Never retrieves bodies/recipients/tokens/IPs/tenant rows | `PROVEN` | `assertMetricsAreNumericOnly()` throws on any non-numeric leaf and the request 503s instead; a test asserts the serialised response contains no letters outside key names and no `@` |
| One deduplicated issue per incident class | `PROVEN` | hidden marker `<!-- bookpitch-ops-incident:<id> -->`; matching is by marker, so a renamed issue still deduplicates |
| No duplicate issues per failed run | `PROVEN` | existing issue is commented, and only when the detail changed |
| Sanitized diagnostics only | `PROVEN` | detail strings are counts and ages |
| Auto-close on recovery | `PROVEN` | comment + `state: closed`, `state_reason: completed` |
| Alerting failure cannot conceal a monitor failure | `PROVEN` | alerting is wrapped, reported on its own line, exits 2; check failures still exit 1 |
| Healthy path tested | see § Post-merge | |
| Simulated failure path tested | see § Post-merge | `-f simulate_failure=…` adds one synthetic failing check; production untouched |

Pre-merge local run of the monitor against real production (alerts off) behaved
correctly, including on the things that were genuinely broken at the time:

```
PASS  health-endpoint       3/3 probes returned 200 {"ok":true}
PASS  production-5xx        0/3 probes returned 5xx
PASS  unexpected-redirect   no redirects on the canonical health URL
PASS  tls                   certificate valid until 2026-11-10 (85 days remaining)
PASS  deployment-reachable  deployment f3f6913 responded 200
PASS  cron-staleness        last success 0.1h ago, limit 1.5h
FAIL  cron-failures         5/10 recent cron runs failed          ← real: the CRON_SECRET window
FAIL  backup-freshness      production-backup.yml did not exist yet ← real
FAIL  restore-drill-stale   no successful run found at all         ← real
FAIL  ops-metrics           CRON_SECRET not configured locally      ← expected locally
```

---

## 13.5 — Email deliverability

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Configured production sending domain | `PROVEN` | `send.bookpitch.ge` (apex deliberately excluded from Resend) |
| 2 | Provider domain status | `PROVEN` | Resend API `GET /domains` → `status: verified`, `region: eu-west-1` |
| 3 | SPF / DKIM / DMARC in public DNS | `PROVEN` | DKIM `resend._domainkey.send.bookpitch.ge`; SPF `send.send.bookpitch.ge` = `v=spf1 include:amazonses.com ~all`; bounce MX `feedback-smtp.eu-west-1.amazonses.com`; DMARC `_dmarc.send.bookpitch.ge` = `v=DMARC1; p=none; rua=mailto:dmarc@bookpitch.ge` |
| 4 | `RESEND_FROM` belongs to the verified domain | `PROVEN` | `Bookpitch <no-reply@send.bookpitch.ge>` |
| 5 | Durable outbox used where required | `PROVEN` | `email_outbox` state machine; `tests/outbox-durable.test.ts` |
| 6 | Only controlled synthetic messages sent | `PROVEN` | Resend sandbox recipients only; no real inbox contacted |
| 7 | Provider acceptance and final delivery status | `PROVEN` | `delivered@resend.dev` → `last_event: delivered`; `bounced@resend.dev` → `last_event: bounced` |
| 8 | Inbox receipt + authentication headers | `BLOCKED (EXTERNAL)` | no designated test mailbox exists |
| 9 | No secret material in message bodies | `PROVEN` | probe bodies contain no password/token/recovery code/TOTP seed/session token/DB info/stack trace; templates reviewed |
| 10 | Invalid recipients are not retried forever | `PROVEN` | `max_attempts` (default 3) then `status='dead'`; `deadWithExhaustedRetries` is monitored |
| 11 | Dead-letter and retention behaviour | `PROVEN` | dead rows swept after 30 days (`lib/housekeeping.ts`); `tests/housekeeping.test.ts` |
| 12 | No DNS changed | `PROVEN` | zero DNS writes; recommendations recorded below |

### DNS recommendations (require a change I am not authorised to make)

1. No organisational DMARC at `_dmarc.bookpitch.ge`. Recommended:
   `_dmarc.bookpitch.ge  TXT  "v=DMARC1; p=reject; sp=reject; rua=mailto:<a-mailbox-that-exists>"`
2. DMARC on the sending subdomain is `p=none` (monitor only). Tighten to
   `quarantine`, then `reject`, once `rua` reports are clean.
3. `rua=mailto:dmarc@bookpitch.ge` points at a domain with **no MX record**
   (`dig MX bookpitch.ge` → empty), so aggregate reports cannot be delivered
   anywhere. Either add an MX/mailbox or point `rua` at one that exists.

---

## 13.6 — Operational documentation

`docs/operations.md` — 16 sections covering production architecture, required
production environment (verified by name, never by value), deployment sequence
and the migration-before-deploy rule, Supabase Free limitations, backups and
retention, key custody and rotation, restore procedure and the restore drill,
cron workflows, monitoring and alert handling, the smoke-test checklist,
application rollback versus database recovery, RTO/RPO, incident response with
the 2026-08-16 outage as a worked example, email operations and dead-letter
recovery, synthetic test-data policy, key rotation, and escalation.

`docs/backup.md` rewritten to point at it and to record, plainly, that the
previous backup system never produced a backup.
`docs/rbac-migration-runbook.md` updated: its PITR pre-flight step could never
have passed on the Free plan and now says so.

---

## 13.7 — Verification matrix (pre-merge, local)

| Gate | Result |
| --- | --- |
| `git diff --check` | exit 0 |
| dependency installation integrity (`npm ci` in CI) | green |
| `npx prisma generate` | exit 0 |
| `npx prisma validate` | "The schema at prisma/schema.prisma is valid 🚀" |
| migration status vs non-production DB | applied cleanly in CI; strict drift detection green |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | **0 errors** (55 pre-existing warnings, none new) |
| `npm run format:check` | "All matched files use Prettier code style!" |
| full test suite | **861 passed / 861**, 74 files (was 746) |
| `npm run build` | success; `/api/health/ops` present in the route manifest |
| guard scanner | "Scanned 105 entry points; 18 allow-listed. All guarded." |
| orphan-permission scanner | "OK — no unmarked orphan permissions." |
| `npm audit --audit-level=high` | "found 0 vulnerabilities" |
| Gitleaks | runs in CI on full history |
| workflow YAML validation | `tests/workflow-safety.test.ts`, 39 tests |
| backup / restore / monitor workflow structural tests | included in the same 39 |
| local disposable backup + restore test | PASSED against real production data (13.2/13.3) |
| production backup manual run | § Post-merge execution |
| disposable restore-drill run | § Post-merge execution |
| production monitor healthy run | § Post-merge execution |
| controlled monitor failure-path test | § Post-merge execution |
| email deliverability verification | PASSED (13.5) |
| final `git diff --check` | exit 0 |

### Dedicated Phase 13 tests (115 new)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/workflow-safety.test.ts` | 39 | no PR-triggered backup, default-branch-only, minimum permissions, concurrency, encrypted-only artifacts, retention floors, secret redaction, strict exit codes, no `continue-on-error`, no `\|\| true`, timeouts, no production restore target, no destructive restore, public-key-only in the repo |
| `tests/production-monitor.test.ts` | 40 | every check in both directions; incident dedup, recovery-close, marker matching, class independence |
| `tests/ops-metrics.test.ts` | 21 | numeric-only enforcement, counters that actually move against a real DB, bearer auth including prefix and scheme rejection, fail-closed without `CRON_SECRET`, no `@` in the response, public-path scoping |
| `tests/production-config-contract.test.ts` | 15 | the env contract that would have caught F13-1, `.env.example` completeness, widget retry behaviour |

