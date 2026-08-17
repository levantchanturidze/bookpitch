# Phase 13 — Production Validation and Operational Reliability Ledger

**Status: PHASE 13 COMPLETE** — 2026-08-17T20:09Z, after a full 24-hour
production soak with zero failures. Verdict and evidence in § 13.9.

**Branch:** `agent/phase-13-production-reliability` (+ follow-ups #7, #8, #10, #11, #12)
**Baseline SHA:** `f3f69135e0a7c50ece182b943d10f08a0f5f19e4` (= `origin/main` at start)
**Final SHA:** `5cb390950a321fccca507cca39a0010a14f33cf7` (deployed, `dpl_uWPCvhmziPbnZKWePCq8sEHSAdZG`)
**Started:** 2026-08-16 · **Completed:** 2026-08-17
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
| full test suite | **869 passed / 869**, 74 files (was 746) — re-run on the merged `0d0a8e5` |
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

### Dedicated Phase 13 tests (123 new)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/workflow-safety.test.ts` | 43 | no PR-triggered backup, default-branch-only, minimum permissions, concurrency, encrypted-only artifacts, retention floors, secret redaction, strict exit codes, no `continue-on-error`, no `\|\| true`, timeouts, no production restore target, no destructive restore, public-key-only in the repo |
| `tests/production-monitor.test.ts` | 44 | every check in both directions; incident dedup, recovery-close, marker matching, class independence |
| `tests/ops-metrics.test.ts` | 21 | numeric-only enforcement, counters that actually move against a real DB, bearer auth including prefix and scheme rejection, fail-closed without `CRON_SECRET`, no `@` in the response, public-path scoping |
| `tests/production-config-contract.test.ts` | 15 | the env contract that would have caught F13-1, `.env.example` completeness, widget retry behaviour |

---

## 13.8 — Post-merge execution against production

| Item | Result | Evidence |
| --- | --- | --- |
| PR #6 merged | ✅ | `10c5863` — Phase 13 implementation |
| PR #7 merged | ✅ | `b88da24` — pin PostgreSQL 17 binaries |
| PR #8 merged | ✅ | `4b4485f` — SIGPIPE in backup verification |
| PR #10 merged | ✅ | `0d0a8e5` — close incidents whose check is no longer reported |
| Deployed SHA | `0d0a8e5` | deployment `dpl_BUpFDMhybGGT6iR3P9iS83A35DzR` → `bookpitch-82v2rd50n-padelebi-s-projects.vercel.app`, GitHub deployment sha `0d0a8e5` |
| Rollback target preserved | ✅ | `dpl_eTLKFHxhZpcr8u8EHC5NdVyvZH5n` @ `f3f69135` (pre-Phase-13) remains Ready |
| No migration ran | ✅ | no `prisma/` change in any Phase 13 PR; `62 migrations found` / `Database schema is up to date!` before and after |

### Three defects found by the new controls, in the order they surfaced

Each was found by a control this phase added, not by reading code. That is the
point of the phase.

1. **Backup run [31967250073](https://github.com/levantchanturidze/bookpitch/actions/runs/31967250073) — `pg_restore: error: unsupported version (1.16) in file header`.**
   The dump was good; the verifier was reading it with the wrong binary.
   Debian's `/usr/bin/pg_*` are `pg_wrapper` shims that pick a version from the
   *server* a command is about to connect to. `pg_restore --list` makes no
   connection, so it fell back to the runner's preinstalled PostgreSQL 16,
   which cannot read a v17 archive. Fixed in PR #7 by putting
   `/usr/lib/postgresql/17/bin` on `PATH` and printing the resolved versions.

2. **Backup run [31967906684](https://github.com/levantchanturidze/bookpitch/actions/runs/31967906684) — `could not write to file: Broken pipe` then a bogus `missing _prisma_migrations`.**
   `pg_restore --list | grep -q` makes grep exit on first match, SIGPIPEing
   `pg_restore`; `set -o pipefail` turned that into a failure and the check
   reported a table it had just found. Fixed in PR #8 by materialising the
   table of contents to a file once.

3. **The alert path opened an incident it could never close.**
   Run [31968584806](https://github.com/levantchanturidze/bookpitch/actions/runs/31968584806)
   opened issue #9 from the synthetic check; the next healthy run reported
   `18/18 checks passed` and left it open, because the synthetic check is
   *absent* from the results rather than passing. Any real check that was
   renamed or removed would have leaked an incident the same way. Fixed in
   PR #10; issue #9 then closed automatically on run
   [31972265082](https://github.com/levantchanturidze/bookpitch/actions/runs/31972265082).

In all three cases the run went **red**, not green. Nothing was silently
accepted.

### Production backup — first green run

Run [31968298749](https://github.com/levantchanturidze/bookpitch/actions/runs/31968298749),
both jobs `success`.

```json
{
  "artifact": "bookpitch-prod-20260816T194107Z-r31968298749a1.tar.age",
  "pg_client_version": "17.11",
  "pg_server_version": "17.6",
  "encrypted_bytes": 297224,
  "sha256": "805d50c366c94016405172dcebba81a5f06ed2557ee4b92e10661b457c802df0",
  "production_identity_fingerprint": "5c9f75110f30141f",
  "schema": "public",
  "toc_entries": 547,
  "globals_status": "ok",
  "verification_status": "pg_restore-list-ok",
  "encryption": "age/x25519"
}
```

Artifacts produced (16 August is a Sunday, so both copies were written):

| Artifact | Bytes | Expires | Retention |
| --- | --- | --- | --- |
| `production-backup-31968298749-1` | 298 429 | 2026-09-20 | 35 days |
| `production-backup-weekly-31968298749-1` | 298 429 | 2026-11-14 | 90 days |

### Artifact downloaded and independently verified (13.2 requirement 21)

Downloaded to a local machine and checked against the owner recovery key —
not the CI copy:

| Check | Result |
| --- | --- |
| contains no plaintext dump | PASS — `strings \| grep -iE 'CREATE TABLE\|PostgreSQL database dump\|organization_id\|PGDMP'` found nothing |
| is an age file | PASS — `age-encryption.org/v1` header |
| checksum file matches | PASS — `shasum -a 256 -c` OK |
| manifest checksum matches the bytes | PASS — `805d50c3…2df0` both sides |
| decrypts with `~/.bookpitch/backup-age-key.txt` | PASS |
| `pg_restore --list` reads the decrypted archive | PASS — 547 entries |
| restores into a disposable database | PASS — all invariants (below) |
| no secret in the workflow logs | PASS — 0 occurrences of `AGE-SECRET-KEY`, `postgres://`, `postgresql://`; 6 `***` redaction markers |

### Restore drill — CI run

Run [31968429868](https://github.com/levantchanturidze/bookpitch/actions/runs/31968429868), `success`.
It located backup run `31968298749` on its own, downloaded
`production-backup-31968298749-1`, and restored it into a `postgres:17`
service container:

```
restore target OK — host=127.0.0.1 port=5432 database=bookpitch_restore_drill (disposable)
→ checksum ok: 805d50c366c94016405172dcebba81a5f06ed2557ee4b92e10661b457c802df0
→ decrypted dump: 243894 bytes
→ table of contents: 547 entries
→ globals: bookpitch_app role definition captured
→ skipping 1 TOC entry: CREATE SCHEMA public (target already has it)
→ pg_restore completed with no errors
ok: 62 prisma migrations, all finished
ok: all 28 required tables present
ok: 10 organizations, memberships structurally valid
ok: audit_log append-only triggers present, 100 rows restored
ok: audit_log UPDATE is rejected by the restored trigger
ok: audit_log has 12 partitions
ok: 21 RLS policies, RLS enabled on tenant tables
ok: owner invariant triggers and functions present
ok: email_outbox schema present
ok: bp_create_monthly_partition() present
=== restore verification: ALL CHECKS PASSED ===
RESTORE DRILL PASSED — the encrypted production backup is recoverable.
```

**The backup is now a proven recovery point, not a hypothesis.**

### Production monitor — healthy run

Run [31968532325](https://github.com/levantchanturidze/bookpitch/actions/runs/31968532325) — 18/18.

```
PASS  health-endpoint          3/3 probes returned 200 {"ok":true}
PASS  production-5xx           0/3 probes returned 5xx
PASS  unexpected-redirect      no redirects on the canonical health URL
PASS  tls                      certificate valid until 2026-11-10 (85 days remaining)
PASS  deployment-reachable     deployment 4b4485f responded 200
PASS  cron-staleness           last success 0.2h ago (run 31967918307), limit 1.5h
PASS  cron-failures            2/10 recent cron runs failed
PASS  backup-freshness         last success 0.1h ago (run 31968298749), limit 26.0h
PASS  restore-drill-stale      last success 0.0h ago (run 31968429868), limit 960.0h
PASS  ops-metrics              /api/health/ops returned 200
PASS  outbox-dead-letters      dead=0 (last 24h: 0, retry-exhausted: 0)
PASS  outbox-stale-claims      staleClaims=0, processing=0
PASS  outbox-backlog           pending=0, queue empty
PASS  housekeeping-stalled     overdue rows — rateLimit=0, tokens=0, reauthGrants=0
PASS  retention-stalled        customers past their retention window still holding PII: 0
PASS  audit-digest-stalled     no audit digest mail has ever been queued (expected on a new deployment)
PASS  partition-maintenance    future monthly partitions=3, rows in audit_log_default=0
PASS  production-config-incomplete  missing required env vars — signup=0, email=0, security=0
```

`production-config-incomplete` reporting `signup=0` is the behavioural
confirmation that the F13-1 configuration fix reached production: before it,
that count was 2.

### Alert path — full lifecycle exercised against the real repository

| Step | Run | Result |
| --- | --- | --- |
| inject a synthetic failing check | [31968584806](https://github.com/levantchanturidze/bookpitch/actions/runs/31968584806) | run **failed** (correct — a red monitor must be a red run); opened issue **#9** |
| same failure again | [31968625264](https://github.com/levantchanturidze/bookpitch/actions/runs/31968625264) | `alert: updated incident #9` — **no duplicate**; 1 open issue |
| failure with a changed detail | [31968646684](https://github.com/levantchanturidze/bookpitch/actions/runs/31968646684) | commented on #9; still 1 open issue |
| recover (before PR #10) | [31968677403](https://github.com/levantchanturidze/bookpitch/actions/runs/31968677403) | 18/18 passed but **#9 stayed open** → defect 3 above |
| recover (after PR #10) | [31972265082](https://github.com/levantchanturidze/bookpitch/actions/runs/31972265082) | **#9 closed** (`state: CLOSED`, `stateReason: COMPLETED`); 0 open `ops-incident` issues |

Production was not affected at any point: the synthetic check is added by the
monitor to its own result list and touches nothing outside GitHub Issues.

### Real Turnstile verified on bookpitch.ge (13.1 items 5–6)

Measured in a real browser against the real domain, after the fix deployed:

```
container div  : present (flex justify-center), 1 child
child          : <input type="hidden" name="cf-turnstile-response"
                   id="cf-chl-widget-…_response" value="1.v8cfFhlwEv…">
token length   : 773 characters
submit button  : ENABLED
```

The site key is configured in **invisible** mode, so there is no visible
challenge iframe — the token is delivered straight into the hidden
`cf-turnstile-response` input. Before the fix that container was empty and no
token existed, so the submit button could never enable.

Server-side binding was then proven from production logs without creating any
record. Two requests were sent from the page with the real token and a
deliberately empty `orgName`, which makes `createPendingRegistration` throw
`InvalidInputError` **before any database access**:

| Request | Status | Production log |
| --- | --- | --- |
| fresh token | 400 | *(no Turnstile log line at all)* |
| same token replayed | 400 | `onboard.turnstile_rejected  codes=["timeout-or-duplicate"]` |

The absence of any rejection line on the first request is the proof: had
siteverify failed, or the action not matched `TURNSTILE_EXPECTED_ACTION`, or the
hostname not been in `TURNSTILE_ALLOWED_HOSTNAMES`, or `challenge_ts` been
outside the five-minute window, `verifyTurnstile()` would have logged the
specific reason and returned false. It logged nothing and returned true; the
400 came from the deliberate validation error afterwards. The replay proves
**single-use** enforcement.

### No production data was created, modified or removed

Row counts after all Phase 13 production work:

| Table | Count | Baseline |
| --- | --- | --- |
| `organizations` | 10 | 10 |
| `app_users` | 16 | 16 |
| `customers` | 2 | 2 |
| `appointments` | 3 | 3 |
| `pending_registrations` | 0 | 0 |
| `email_outbox` | 0 | 0 |
| organisations tagged `E2E-PHASE13%` | **0** | — |
| `audit_log` rows written since 18:00 UTC | **0** | — |

No synthetic record needed archiving because none was ever created: every probe
was designed to be rejected before the first write. Requirement 13.1.26 is
satisfied vacuously and 13.1.27 is satisfied by measurement.

### Stale alert resolved

Issue #4 ("[urgent] Migration workflow failed", opened 2026-08-06) was closed
with an explanation. It had stayed open for ten days because `migrate.yml`
opens and comments on incidents but has no recovery path — the same one-way
alerting gap Phase 13 fixed for the monitor. Folding `migrate.yml` into the
same mechanism is recorded as follow-up work, not done here.

Open `ops-incident` issues at end of Phase 13: **0**. Open issues overall: **0**.

---

## 13.1 items deliberately not exercised against production

Two groups, both conscious limits rather than omissions.

**Account creation (items 7, 13–15).** Completing the signup form would create a
real organisation and user in production. I do not create accounts or enter
passwords into forms — that boundary holds regardless of authorisation, and it
is not a judgement about this request. Separately, the resulting organisation
could not be removed through a supported application path without provisioning
a production SUPER_ADMIN, which is a larger security action than the coverage
would justify. Everything up to the account-creation step is proven above,
including the part that was actually broken. The activation semantics
(single-use token, safe second attempt, coherent org+owner transaction) are
covered by `tests/onboard-activation.test.ts` against a real database. The
remaining human action is listed in § External blockers.

**Platform plane (items 16–22).** Sign-in/out, MFA enrolment and confirmation,
recovery codes, purpose-bound reauthentication and break-glass are proven by
`tests/platform-*.test.ts` against a real seeded database. Exercising
break-glass in production means reaching real client PII and writing real audit
rows; the coverage is not worth that. Recorded as a limit.

---

## External blockers

Consolidated. Each needs a human or a spending decision; none blocks anything
else in Phase 13.

1. **No designated test mailbox.** No `E2E_TEST_EMAIL` or equivalent exists in
   the repository, in Vercel, or in GitHub secrets. Nothing was guessed.
   Consequence: inbox receipt and SPF/DKIM/DMARC *header* verification
   (13.1.12, 13.5.8) are unproven. Provider-side acceptance and final delivery
   status **are** proven via Resend's sandbox recipients. To close this: set a
   real mailbox you control as `E2E_TEST_EMAIL` and re-run the deliverability
   probe.

2. **Production signup submission (13.1 items 7, 13–15).** Requires a human to
   complete the form once. Exact steps are in the final report.

3. **DNS — no organisational DMARC record.** `_dmarc.bookpitch.ge` does not
   exist. Recommended:
   `_dmarc.bookpitch.ge TXT "v=DMARC1; p=reject; sp=reject; rua=mailto:<a-mailbox-that-exists>"`.
   Not applied: DNS changes are not authorised.

4. **DNS — DMARC on the sending subdomain is `p=none`.** Monitor-only. Tighten
   to `quarantine`, then `reject`, once `rua` reports are clean.

5. **DNS — `rua=mailto:dmarc@bookpitch.ge` is undeliverable.** `dig MX
   bookpitch.ge` returns nothing, so DMARC aggregate reports have nowhere to
   go. Either add an MX/mailbox or point `rua` at a domain that has one.

6. **Backup ciphertext residency.** GitHub Actions artifacts are not
   EU-guaranteed. Mitigated by client-side `age`/X25519 encryption with a key
   GitHub never holds. Restoring EU residency needs an `eu-central-1` object
   store or Supabase Pro — both spending decisions, both out of scope.

7. **RPO is 24 hours.** A direct consequence of daily logical backups on
   Supabase Free. Reducing it requires PITR, which requires Supabase Pro.

8. **Single-operator escalation.** There is no second responder. Recorded in
   `docs/operations.md` §16 as a real risk.


---

## 13.9 — Production soak

**Status: PASSED.** Evidence collected 2026-08-17T20:04Z–20:09Z.

### Soak window, and why it starts where it does

Phase 13.9 requires 24 hours "after deployment and operational workflows are
active", and requires the clock to restart only for **material** production
changes. Three candidate start points, and what each yields:

| Basis | Timestamp | 24h completes | Elapsed at collection? |
| --- | --- | --- | --- |
| Operational workflows active (first scheduled monitor run `31968580233`) | 2026-08-16T19:46:32Z | 2026-08-17T19:46:32Z | **yes** |
| **Last material production change** — `0d0a8e5`, deployment `5934823746` | **2026-08-16T19:55:36Z** | **2026-08-17T19:55:36Z** | **yes** |
| Last deployment of any kind — `5cb3909`, deployment `5935566270` | 2026-08-16T21:18:56Z | 2026-08-17T21:18:56Z | no (~70 min short) |

The third row is a **documentation-only** deployment. `git diff --stat 0d0a8e5
5cb3909` is one file:

```
 docs/phase-13-production-reliability-ledger.md | 315 ++++++++++++++++++++++++-
 1 file changed, 311 insertions(+), 4 deletions(-)
```

No application code, no workflow, no configuration. It changed nothing about
how production behaves, so it does not restart the clock. **The soak window
used here is 2026-08-16T19:55:36Z → 2026-08-17T19:55:36Z**, a full 24h00m, and
it has elapsed. Stating the conservative reading explicitly so the judgement is
auditable rather than assumed.

### 1. No unplanned deployment, migration or configuration change

| Check | Result |
| --- | --- |
| Production deployments during the window | **none** — last was `5cb3909` at 21:18:56Z, before the window's end and docs-only |
| Deployments in an `Error` state | none; the six most recent are all `● Ready` |
| Migrations applied during the window | **none** — `migrate.yml` did not run; no `prisma/` change has landed since `f3f69135` |
| Vercel env changes | none after the two Turnstile variables added pre-soak |
| GitHub secrets changed | none — `gh secret list` timestamps unchanged (latest `BACKUP_AGE_PRIVATE_KEY` 2026-08-16T18:26:26Z) |
| `origin/main` moved | no — still `5cb3909` throughout |

### 2. Monitor runs — every scheduled run in the window

35 runs inside the window, **zero non-success of any kind**.

| Metric | Value |
| --- | --- |
| runs in window | 35 (33 scheduled, 2 dispatched) |
| scheduled successes | **33 / 33** |
| scheduled failures | **0** |
| dispatched failures | **0** |
| first scheduled run | 2026-08-16T20:28:43Z — [31970647745](https://github.com/levantchanturidze/bookpitch/actions/runs/31970647745) |
| last scheduled run | 2026-08-17T19:53:35Z — [32062832432](https://github.com/levantchanturidze/bookpitch/actions/runs/32062832432) |
| continuous scheduled coverage | 23.41 h |
| largest gap between scheduled runs | 113 min (2026-08-16T23:47:31Z → 2026-08-17T01:40:34Z) |

Final end-of-soak run [32064242321](https://github.com/levantchanturidze/bookpitch/actions/runs/32064242321)
at 2026-08-17T20:09:25Z — **18/18 checks passed**.

**Recorded limitation, not a failure:** the workflow is scheduled `5,35 * * * *`,
which is 48 runs a day; 33 fired. GitHub Actions scheduled workflows are
best-effort and are delayed or dropped under load — that is documented GitHub
behaviour, not a fault in this workflow, and every run that did fire passed.
The practical effect is that worst-case detection latency is ~2 h rather than
the nominal 30 min. If tighter latency is ever required it needs an external
scheduler, which is a spending decision. This is now a known property of the
monitoring design rather than an assumption.

### 3. Production health throughout

Each monitor run performs 3 health probes requiring an exact `{"ok":true}` body,
plus a TLS handshake, redirect detection and 5xx counting. Across 33 scheduled
runs that is **99 health probes, all passing**. No run reported a redirect, a
5xx, or a TLS problem at any point.

### 4. Cron workflows

| Metric | Value |
| --- | --- |
| `cron.yml` runs in window | **62** |
| outcomes | `{"success": 62}` — **zero non-success** |
| first / last | 2026-08-16T20:20:07Z / 2026-08-17T19:50:54Z |

Job-level confirmation for the non-15-minute slots:

| Job | Run | Result |
| --- | --- | --- |
| `retention` (nightly 02:17 UTC) | [31990397744](https://github.com/levantchanturidze/bookpitch/actions/runs/31990397744) @ 03:12:18Z | `retention=success` |
| `housekeeping` (hourly) | [31989649819](https://github.com/levantchanturidze/bookpitch/actions/runs/31989649819) @ 02:58:42Z | `housekeeping=success` |
| `reminders` (every 15 min) | [31989667163](https://github.com/levantchanturidze/bookpitch/actions/runs/31989667163) @ 02:59:04Z | `reminders=success` |

### 5. Scheduled encrypted backup — fired unattended and passed

Run [31988958792](https://github.com/levantchanturidze/bookpitch/actions/runs/31988958792),
event `schedule`, both jobs `success`. This is the first backup this project has
ever taken without a human triggering it.

```json
{
  "artifact": "bookpitch-prod-20260817T024537Z-r31988958792a1.tar.age",
  "pg_client_version": "17.11",
  "pg_server_version": "17.6",
  "encrypted_bytes": 297224,
  "sha256": "2f26a1b3a4cef601017bd3757a783128b8af9470e62540a16115bfa5ba4c0a5c",
  "toc_entries": 547,
  "globals_status": "ok",
  "verification_status": "pg_restore-list-ok"
}
```

- `OK: only encrypted artifacts staged`
- `restorable entries: 547`
- checksum verified: `bookpitch-prod-20260817T024537Z-r31988958792a1.tar.age: OK`
- `OK: artifact is encrypted, intact, and restorable.`
- artifact `production-backup-31988958792-1`, 298 429 bytes, expires 2026-09-21 (35 days)

No weekly copy on this run, correctly — 2026-08-17 is a Monday.

**There are now two independent, verified recovery points**: the manual
`31968298749` (with a 90-day weekly copy) and this unattended `31988958792`.

### 6. Alerts

| Check | Result |
| --- | --- |
| `ops-incident` issues opened during the window | **0** |
| Any issue of any kind created during the window | **0** |
| Open `ops-incident` issues now | **0** |
| Open issues of any kind now | **0** |

The only `ops-incident` ever raised is #9, the synthetic alert-path test, opened
2026-08-16T19:47:02Z and **auto-closed 2026-08-16T20:28:59Z** by the scheduled
run `31970647745` — closed unattended, not by a manual dispatch.

### 7. Vercel runtime and deployment logs

| Check | Result |
| --- | --- |
| runtime log rows retrieved | 13 (2026-08-17T19:16:42Z → 19:53:48Z) |
| response status distribution | `{"200": 13}` |
| 5xx or error-level rows | **0** |
| application `warn`/`error` log lines | **0** |
| distinct application messages | `db.prismaLogin.init`, `housekeeping.ok` |
| deployments in `Error` state | **0** |

Vercel's plan retains only a short runtime-log window, so direct log evidence
covers the most recent ~37 minutes. The remaining 23-plus hours are covered by
the 99 health probes and the 5xx detection in the 33 scheduled monitor runs,
which is why the monitor counts 5xx itself rather than relying on log retention.

### 8. Endpoint health at end of soak (docs/operations.md §9)

| # | Check | Result |
| --- | --- | --- |
| 1 | `/api/health` body | `{"ok":true}` — byte-exact |
| 2 | status / redirects / TLS | `http=200 redirects=0 tls_verify=0` |
| 3 | `/signup` renders | heading match |
| 4 | signup without a Turnstile token | `400` |
| 5 | 200 KB request body | `413` |
| 6 | resend, unknown address | `{"ok":true}` — enumeration-safe |
| 7 | verify with a garbage token | `307 → /onboard/expired`, no 5xx |
| 8 | `/dashboard`, `/platform`, `/api/customers`, `/api/health/ready` | all `307`, none `200` |
| 9 | `/api/health/ops` without bearer | `401` |
| 10 | `www.bookpitch.ge` | `308 → https://bookpitch.ge` |

TLS: `CN=*.bookpitch.ge`, Let's Encrypt, valid `Aug 12 2026` → `Nov 10 2026`
(84 days remaining).

### 9. Deployed SHA still matches the approved final Phase 13 SHA

| Check | Value |
| --- | --- |
| approved final Phase 13 SHA | `5cb390950a321fccca507cca39a0010a14f33cf7` |
| current production deployment | `dpl_uWPCvhmziPbnZKWePCq8sEHSAdZG` |
| deployment URL | `bookpitch-gek8anll0-padelebi-s-projects.vercel.app` |
| GitHub deployment record | `5935566270`, sha `5cb3909`, 2026-08-16T21:18:56Z |
| status | `● Ready` |
| monitor `deployment-reachable` | passes, reporting `5cb3909` |

### 10. Database state

```
62 migrations found in prisma/migrations
Database schema is up to date!          (exit 0)
```

| Table | Baseline | After soak |
| --- | --- | --- |
| `organizations` | 10 | **10** |
| `app_users` | 16 | **16** |
| `customers` | 2 | **2** |
| `appointments` | 3 | **3** |
| `pending_registrations` | 0 | **0** |
| organisations tagged `E2E-PHASE13%` | 0 | **0** |
| `_prisma_migrations` | 62 | **62** |
| `audit_log` rows written during the soak | — | **0** |

Operational metrics at end of soak, all zero:

| Metric | Value |
| --- | --- |
| `email_outbox` dead letters | 0 |
| `email_outbox` rows, any status | 0 |
| stale processing claims | 0 |
| housekeeping arrears (rate_limit) | 0 |
| housekeeping arrears (verification tokens) | 0 |
| rows in `audit_log_default` | 0 |

### 11. Repository state

| Check | Result |
| --- | --- |
| `git status --short` | empty (clean) |
| `origin/main` | `5cb390950a321fccca507cca39a0010a14f33cf7` |
| unplanned commits during the soak | none |
| force-push or history rewrite | none |

### 12. Secrets verified by name, never by value

GitHub Actions: `ADMIN_MIGRATE_DATABASE_URL`, `APP_URL`,
`BACKUP_AGE_PRIVATE_KEY`, `CRON_SECRET`, `DATABASE_URL_SUPERUSER_MIGRATE`.

Vercel Production (27 variables, all `Encrypted`), including all four Turnstile
variables, `RESEND_API_KEY`/`RESEND_FROM`, `CRON_SECRET`, `AUTH_SECRET`,
`FIELD_ENCRYPTION_KEY`, `RATE_LIMIT_HMAC_KEY`, `EMAIL_PRIVACY_HMAC_KEY`.

No value was read, printed or logged at any point.

### Soak verdict

Every mandatory gate held for the full 24-hour window with **zero failures,
zero incidents, zero 5xx, zero unplanned changes and zero writes to production
data**. Phase 13.9 passes.


---

## Change log

- 2026-08-16 18:20 UTC — 13.0 baseline recorded; branch created.
- 2026-08-16 19:14 UTC — PR #6 opened, CI green, merged as `10c5863`.
- 2026-08-16 19:33 UTC — PR #7 (`b88da24`) after backup run 31967250073 failed verification.
- 2026-08-16 19:39 UTC — PR #8 (`4b4485f`) after backup run 31967906684 failed verification.
- 2026-08-16 19:41 UTC — backup run 31968298749 green; artifact verified independently.
- 2026-08-16 19:44 UTC — restore drill 31968429868 green.
- 2026-08-16 19:46 UTC — monitor 18/18; alert lifecycle exercised.
- 2026-08-16 19:55 UTC — PR #10 (`0d0a8e5`) closes orphaned incidents.
- 2026-08-16 21:02 UTC — issue #9 auto-closed; 0 open incidents.
- 2026-08-16 21:06 UTC — real Turnstile token accepted by production; replay rejected.
- 2026-08-16 21:15 UTC — stale issue #4 closed; soak begins.
- 2026-08-17 20:04–20:09 UTC — 24h soak evidence collected; all gates green; Phase 13 marked COMPLETE.
