# Bookpitch — Production Operations Runbook

Everything an operator needs to run, recover, and reason about production.
Written 2026-08-16 (Phase 13). No credential, connection string, key, token or
customer identifier appears in this file — commands show you how to obtain a
value, never the value itself.

---

## 1. Production architecture

| Layer | What it is | Where |
| --- | --- | --- |
| Domain | `bookpitch.ge` (apex). `www.bookpitch.ge` and `http://` 308-redirect to it. | DNS on Vercel (`ns1/ns2.vercel-dns.com`) |
| Application | Next.js 16 App Router, Node runtime, Vercel Production | project `padelebi-s-projects/bookpitch`, region `fra1` |
| Database | Supabase PostgreSQL **17.6**, **Free plan**, `eu-central-1` | reached through the Supavisor session pooler (IPv4) |
| Email | Resend, region `eu-west-1`, verified domain `send.bookpitch.ge` | `EMAIL_PROVIDER=resend` |
| Scheduled work | GitHub Actions (`cron.yml`) → bearer-authenticated `/api/cron/*` | not Vercel Cron |
| Backups | GitHub Actions (`production-backup.yml`) → age-encrypted artifact | see §4 |
| Monitoring | GitHub Actions (`production-monitor.yml`) every 30 min | see §8 |
| Error tracking | Sentry | `SENTRY_ENVIRONMENT=production` |

Database roles (see `docs/rbac-spec.md` §9 for the full rationale):

- `postgres` — schema owner, `BYPASSRLS`. Migrations and backups only.
- `bookpitch_app` — the runtime role. `NOSUPERUSER NOBYPASSRLS`, no `UPDATE` on
  `audit_log`. CI asserts both attributes on every run.

### Free-plan consequences you must know

Supabase Free has **no automated backups and no point-in-time recovery**. Both
are paid-tier features. `production-backup.yml` is therefore not a belt-and-
braces extra — **it is the only recovery point that exists**. A red backup run
is a production incident, not a chore.

RPO/RTO under this design are in §11.

---

## 2. Required production environment

The application fails closed on several of these, sometimes silently. The
production monitor counts how many are missing every 30 minutes
(`lib/ops-metrics.ts`, check id `production-config-incomplete`) — that check
exists because two of them were unset for a week and nobody noticed.

Verify **by name, never by value**:

```bash
vercel env ls production          # names + "Encrypted", never the values
gh secret list                    # GitHub Actions secret names + last update
```

| Variable | Owner | Failure mode if missing |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | Vercel | signup fails closed in production |
| `TURNSTILE_EXPECTED_ACTION` | Vercel | **every signup returns 400** (see §12) |
| `TURNSTILE_ALLOWED_HOSTNAMES` | Vercel | **every signup returns 400** (see §12) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Vercel | widget never renders; submit stays disabled |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_FROM` | Vercel | no verification or alert mail is ever sent |
| `AUTH_SECRET` | Vercel | sessions cannot be signed |
| `FIELD_ENCRYPTION_KEY` | Vercel | encrypted columns unreadable |
| `PAYMENT_GATEWAY` | Vercel | **payments refuse to run** — `getGateway()` throws rather than falling back to the mock adapter (F16-001) |
| `EMAIL_PROVIDER`, `SMS_PROVIDER` | Vercel | **outbound messaging refuses to run** — the resolvers throw rather than silently mocking a send (F16-002) |
| `RATE_LIMIT_HMAC_KEY`, `EMAIL_PRIVACY_HMAC_KEY` | Vercel | PII hashed with a fallback key |
| `CRON_SECRET` | Vercel **and** GitHub | every cron run 401s (see §7) |
| `DATABASE_URL`, `DATABASE_URL_APP_NOBYPASSRLS`, `DATABASE_URL_LOGIN`, `DATABASE_URL_SUPERUSER_TXPOOL`, `ADMIN_DATABASE_URL`, `DIRECT_URL` | Vercel | app cannot reach the database |
| `SENTRY_DSN` | Vercel | **every uncaught server/edge exception is discarded** (see below) |
| `NEXT_PUBLIC_SENTRY_DSN` | Vercel | every uncaught browser exception is discarded |
| `SENTRY_AUTH_TOKEN` | Vercel **and** GitHub | source maps are not uploaded at build time, so every production stack trace is unreadable minified frames; and events cannot be read back, so receipt cannot be proven |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Vercel **and** GitHub | as above — the upload and the API read both need to know which project |
| `SENTRY_PROBE_ENABLED` | Vercel, temporarily | the verification probes 404. Set to `"true"` only for a verification window, then unset — it is a switch, not a setting |
| `DATABASE_URL_SUPERUSER_MIGRATE` | GitHub | migrations and **backups** fail |
| `BACKUP_AGE_PRIVATE_KEY` | GitHub | backups still run; nothing can be restored |
| `APP_URL` | GitHub | cron workflow has no target |

> These three rows used to sit *below* the Sentry prose that follows, outside
> the table, so they rendered as a stray line of pipe characters and the three
> GitHub-only secrets looked undocumented.

### Present is not valid, and not-yet-configured is not broken

Three monitor checks read this configuration, and they mean different things.
Reading them as one is what made the first of them useless for a fortnight.

| Check | Reads | What a failure means |
| --- | --- | --- |
| `production-config-incomplete` | variables that are **unset** | the product is broken in a way the code will fail closed on |
| `production-config-invalid` | `SECRET_ENV_VALIDATORS` — `FIELD_ENCRYPTION_KEY`, `EMAIL_PRIVACY_HMAC_KEY`, `RATE_LIMIT_HMAC_KEY`, `AUTH_SECRET` | **P0.** The value is present, so the check above is green, and the application throws at the first call that uses it. This is P15-010 exactly. |
| `production-provider-mocked` | `PROVIDER_ENV_VALIDATORS` — `PAYMENT_GATEWAY`, `EMAIL_PROVIDER`, `SMS_PROVIDER` | **PAUSE** when a provider is on `mock`: a pre-launch decision, nothing is delivered, and the resolvers refuse `mock` in production anyway. **FAIL** when a value is neither a real adapter nor `mock` — a typo, which fails closed at the first send and nowhere earlier. |

The providers used to be validated by the same table as the secrets, so on
2026-09-01 production reported "A required secret is set but structurally
unusable — malformed: 2" while both were a payment gateway and an SMS provider
deliberately left on `mock`. A check that is permanently red for a decision is
a check nobody reads, which is the whole reason `production-config-invalid`
exists.

Names never leave the server in any of the three. The endpoint returns counts
only, and `assertMetricsAreNumericOnly()` refuses the request rather than emit
a string.

### Sentry (P17-007)

Every `Sentry.init()` in this repository sits inside `if (process.env.…_DSN)`.
An absent DSN is therefore not a degraded mode — no client is created and
`captureException` is a no-op. Production ran that way with
`SENTRY_ENVIRONMENT` and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` both set, which is
precisely what made it look configured.

Check id `production-observability-unconfigured`, deliberately separate from
`production-config-incomplete`: missing signup or security config means the
product is broken, a missing DSN means the product works and nobody can see it
break. One status line for both would get the first read as the second.

To prove it works rather than assume it, run:

```bash
APP_URL=… CRON_SECRET=… SENTRY_AUTH_TOKEN=… SENTRY_ORG=… SENTRY_PROJECT=… \
  npm run verify:sentry
```

It reports five levels — CONFIGURED, INITIALISED, EMITTED, INDEXED, **VERIFIED**
— and exits non-zero below level 5, per runtime. Levels 1–3 all pass against a
well-formed DSN pointing at a project that does not exist; level 4 passes on a
stack of unreadable minified chunks. Only VERIFIED means an error would reach a
human in a form anyone can act on.

Every level is measured against the **deployed application**, not the machine
running the script:

- **server** — `POST /api/health/sentry-probe` with bearer `CRON_SECRET`;
- **browser** — a real headless Chromium loading `/probe/sentry` on the
  deployed site. Nothing runnable from Node exercises
  `NEXT_PUBLIC_SENTRY_DSN`, the browser bundle or the browser source maps, so
  nothing runnable from Node can stand in for this.

Both probes carry the same freshly minted nonce and throw a real `Error`, so
the events can be proven to belong to this run and both have a stack to
symbolicate.

The probe surface is off by default. It requires `SENTRY_PROBE_ENABLED` to be
exactly `"true"` and 404s otherwise; the browser page additionally requires a
five-minute HMAC from `POST /api/health/sentry-probe/token`, so `CRON_SECRET`
never reaches client JavaScript or a URL. **Turn `SENTRY_PROBE_ENABLED` off
again once verification is done** — it is a verification switch, not a setting.

Source maps: `next.config.ts` is wrapped in `withSentryConfig` and uploads maps
when `SENTRY_AUTH_TOKEN` is present, with `deleteSourcemapsAfterUpload` so they
do not also land on the CDN. Both halves are checked rather than assumed —
level 5 requires original-source frames on **both** runtimes (proving the maps
reached Sentry), and a separate check fetches a served chunk's
`sourceMappingURL` and requires it to be **unreachable** (proving they did not
reach the public).
`.env.example` documents every one of these. A test
(`tests/production-config-contract.test.ts`) fails if a required variable is
added to the contract without being documented.

> **`pg_restore --list` is not a restore.** `production-backup.yml`'s verify job
> downloads the artifact it just uploaded, checks the checksum, decrypts it and
> reads its table of contents. That proves the archive is intact and readable —
> it does not prove it loads. Only `restore-drill.yml` proves that: it restores
> into a disposable database and runs the production invariants against the
> result. A release gate needs the drill, not the readability check.

> Sensitive Vercel variables are **one-way**: they cannot be read back through
> the API or CLI. Whatever local file holds the plaintext must be updated at
> rotation time or the next session starts blocked (CLAUDE.md, F-12).

---

## 3. Deployment sequence

Vercel deploys automatically on push to `main`. The migration workflow fires
from the same push. **Migrations must land before or with the code that needs
them**, which is guaranteed by the expand-only rule, not by ordering.

1. Open a PR against `main`. CI must be green: format, lint, types, Prisma
   validate, strict drift detection, seeded test DB, full suite, guard scanner,
   orphan-permission scanner, `npm audit --audit-level=high`, gitleaks, build.
2. **Before merging anything that touches `prisma/`**, confirm a recent green
   `production-backup.yml` run. If there is not one, run it manually and wait.
3. Merge. Vercel builds the merge commit; `migrate.yml` runs
   `prisma migrate deploy` against `DATABASE_URL_SUPERUSER_MIGRATE`.
4. Verify:

   ```bash
   curl -sS https://bookpitch.ge/api/health          # must be exactly {"ok":true}
   vercel inspect bookpitch.ge | sed -n '1,20p'      # id, target, status
   gh run list --workflow=migrate.yml --limit 1
   gh workflow run production-monitor.yml            # full smoke pass on demand
   ```

5. Keep the previous deployment as the rollback target (§10).

### The migration-before-deploy rule

Every migration is **expand-only**: add columns and tables, never remove or
narrow a shape in the same PR that ships the code depending on it. That is what
makes it safe for the deployed code to run for a minute against the pre-
migration schema. Removals go in a *later* PR, after the code that used the old
shape is gone from production. Every migration has a written rollback.

Adding a Vercel environment variable does **not** apply to running deployments.
Add the variable, then redeploy:

```bash
printf '%s' "$VALUE" | vercel env add NAME production   # never --value: it lands in ps and shell history
vercel redeploy <deployment-url>                        # or push an empty commit
```

---

## 4. Backups

**Workflow:** `.github/workflows/production-backup.yml`
**Script:** `scripts/backup-production.sh`
**Schedule:** 01:40 UTC daily, plus `workflow_dispatch`. Default branch only.

What one run does, in order:

1. Installs `postgresql-client-17` (matching the 17.6 server — `pg_dump`
   refuses to dump from a newer server) and `age`.
2. `pg_dump --format=custom --compress=9 --schema=public` into a 0700 temp dir.
3. `pg_dumpall --globals-only --no-role-passwords` for roles and grants. The
   script **refuses to ship** a globals file that contains a role password.
4. `pg_restore --list` on the plaintext archive. Fewer than 20 restorable
   entries, or a missing `_prisma_migrations` / `organizations` / `audit_log`
   table, aborts the run before anything is published.
5. `tar` + `age --encrypt` to the public recipient in
   `ops/backup-age-recipient.txt`. The output is checked for the
   `age-encryption.org` header and deleted if it is not an age file.
6. SHA-256 and a `manifest.json` holding only: UTC timestamp, client/server
   versions, encrypted size, checksum, a **hashed** production identity
   fingerprint, TOC entry count, globals status, verification status.
7. Upload as a GitHub Actions artifact — **encrypted bytes only**. A dedicated
   step fails the run if any unexpected file, any `PGDMP` header, or any
   plaintext SQL marker is staged.
8. A **separate job** (which has the private key but *not* the database URL)
   downloads the artifact, verifies the checksum, decrypts it, and runs
   `pg_restore --list` on the result. Every backup is proven readable the day
   it is taken.

The connection URL never reaches `argv`, a log, or a filename:
`scripts/pg-conn-env.py` parses it into `PG*` variables and a 0600 `.pgpass`.

### Retention

| Copy | Retention | Recovery points |
| --- | --- | --- |
| daily | 35 days | 35 daily, containing 5 weekly |
| weekly (Sundays) | 90 days | 12–13 weekly |

Combined this exceeds the 31-day / 7-daily / 4-weekly requirement even if a
full week of daily runs fails.

### Manual backup

```bash
gh workflow run production-backup.yml
gh run watch "$(gh run list --workflow=production-backup.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

### Where backups live, and the residency trade-off

Backups are GitHub Actions artifacts. GitHub does not guarantee EU-region
storage for artifacts, so the **ciphertext** may rest outside the EU. Mitigation:
the data is encrypted client-side with `age`/X25519 before it leaves the runner,
and GitHub never holds the private key. The previous design targeted an
`eu-central-1` S3 bucket — but it required AWS secrets that were never created,
so **it produced zero backups in its entire lifetime** (every scheduled run
failed from 2026-07 to 2026-08-16). A working encrypted backup outside the EU is
strictly better than a non-existent one inside it.

If EU residency of backup ciphertext is required, the options both need a
spending decision and are therefore **not** implemented here:

- add an `eu-central-1` object store and push the same encrypted artifact to it;
- upgrade Supabase to Pro for provider-side backups and PITR in-region.

---

## 5. Backup key custody

`age` X25519 key pair, generated 2026-08-16.

- **Public recipient** — `ops/backup-age-recipient.txt`, committed. It can only
  encrypt. Safe in the repository, safe in a screenshot.
- **Private key** — exists in exactly two places:
  1. GitHub Actions secret `BACKUP_AGE_PRIVATE_KEY` (restore drill + verify job)
  2. Owner recovery copy at `~/.bookpitch/backup-age-key.txt`, mode `0400`

Confirm the recovery copy exists and is locked down, without printing it:

```bash
ls -l ~/.bookpitch/backup-age-key.txt   # expect -r-------- owned by you
age-keygen -y ~/.bookpitch/backup-age-key.txt   # prints only the PUBLIC half
```

The public half printed by that command must equal the line in
`ops/backup-age-recipient.txt`. If it does not, the secret and the recipient
have drifted and **no current backup can be decrypted** — treat as a P1.

### Backup key rotation

Rotating the recipient makes every previously-taken backup undecryptable with
the new key. So:

1. Generate the new pair; keep the old private key **forever** (or at least
   past the retention window of every backup encrypted to the old recipient).
2. `gh secret set BACKUP_AGE_PRIVATE_KEY < <new-key-file>` (stdin, never a flag).
3. Replace the line in `ops/backup-age-recipient.txt`, commit, merge.
4. Run `production-backup.yml` manually and then `restore-drill.yml` against
   that run. Only after the drill passes is the rotation complete.

---

## 6. Restore

### Restore drill (proves the chain, touches nothing real)

**Workflow:** `.github/workflows/restore-drill.yml` — 03:20 UTC on the 4th of
each month, plus `workflow_dispatch` (optionally with a specific backup run id).

```bash
gh workflow run restore-drill.yml
gh workflow run restore-drill.yml -f backup_run_id=<run-id>   # a specific backup
```

It finds the latest successful backup, verifies the checksum, decrypts inside
the runner, and restores into a `postgres:17` **service container**. Then
`scripts/restore-verify.sql` asserts: 60+ finished Prisma migrations, 28
required tables, structurally valid tenant rows, the three `audit_log`
append-only triggers **and that an UPDATE against `audit_log` is actually
rejected**, the monthly partition set, 15+ RLS policies with RLS enabled on
tenant tables, the owner-invariant triggers and functions, the `email_outbox`
schema, and `bp_create_monthly_partition()`.

It cannot reach production. `scripts/assert-disposable-db.py` runs **before
anything is decrypted** and is an allow-list: loopback hosts only, no
managed-provider hostnames, no URL byte-identical to any known production URL,
and no production-shaped database name. The workflow references no production
database secret at all — a test asserts that.

### Real recovery into production (human-driven, never automated)

There is no automation for this and there must not be. If you have to do it:

1. **Stop writes.** Suspend the Vercel deployment or put the app in maintenance;
   a restore racing live traffic produces a worse state than the outage.
2. Take a fresh backup of the damaged database first, whatever its state. You
   will want it.
3. Download and verify the chosen artifact:

   ```bash
   gh run download <backup-run-id> -n production-backup-<run-id>-<attempt> -D ./restore
   cd restore && sha256sum -c *.tar.age.sha256
   age --decrypt --identity ~/.bookpitch/backup-age-key.txt -o bundle.tar *.tar.age
   tar -xf bundle.tar && pg_restore --list database.dump | head
   ```

4. Restore into a **new** Supabase project or database, never over the live one.
5. Point `DATABASE_URL*` at the restored database, redeploy, smoke-test (§9).
6. Only then decommission the damaged database.

`prisma migrate reset` and `prisma db push` are never run against production.

### When the database host itself is gone (2026-09-01)

Distinguish this from a credential problem before doing anything, because the
remedies are opposite: a rotated password is a five-minute fix, a deleted
project is a restore.

```bash
# 1. Does the project still exist at all?  NXDOMAIN here is decisive.
host "db.<project-ref>.supabase.co"
host "<project-ref>.supabase.co"

# 2. What does the pooler say?  Read the message, not just the failure.
#    "tenant/user … not found"          → the project is unknown to the pooler
#    "password authentication failed"   → the project exists; rotate, do not restore
PGCONNECT_TIMEOUT=10 psql "$URL" -tAc 'select 1'

# 3. Both poolers, both ports — a project can move between aws-0 and aws-1.
```

A *paused* Supabase project still resolves in DNS. `NXDOMAIN` on the project
host, plus `tenant/user not found` on both poolers and both ports, means the
project is gone and the recovery above is the only path.

Two traps this outage exposed:

- **`/api/health` will still return `200 {"ok":true}`.** It is a process
  liveness probe and deliberately touches nothing. It is not evidence that
  anything works. `/api/health/ops` is the endpoint that would have said so, and
  it needs `CRON_SECRET`.
- **A Sensitive Vercel variable cannot be read back.** `vercel env pull`
  returns it empty, so you cannot compare production's `DATABASE_URL` against a
  local one. Read the project ref out of a runtime log instead
  (`vercel logs <deployment> --json`), which is where this one was confirmed.

After restoring into a new project, the runtime role needs its own password —
Supabase's dashboard reset only rotates `postgres`:

```sql
ALTER USER bookpitch_app WITH PASSWORD '<new>';
```

Then update, in Vercel Production: `DATABASE_URL`, `DIRECT_URL`,
`ADMIN_DATABASE_URL`, `DATABASE_URL_LOGIN`, `DATABASE_URL_SUPERUSER_TXPOOL`;
and in GitHub Actions secrets: `DATABASE_URL_SUPERUSER_MIGRATE`,
`ADMIN_MIGRATE_DATABASE_URL`. Redeploy, then run
`.github/workflows/migrate.yml` — a restored dump is at the migration count of
the day it was taken, not of `main`.

---

## 7. Scheduled jobs

`.github/workflows/cron.yml`, all bearer-authenticated with `CRON_SECRET`:

| Job | Schedule (UTC) | Endpoint | Produces outbound email? | Visible symptom if it stops |
| --- | --- | --- | --- | --- |
| reminders | every 15 min | `/api/cron/reminders` | **YES — sends email and SMS directly** | reminders stop going out |
| housekeeping | hourly at :03 | `/api/cron/housekeeping` | **YES — `drainEmailOutbox()` DELIVERS everything queued** | outbox stops draining; stale rows accumulate |
| retention | 02:17 daily | `/api/cron/retention` | no | customers past their window keep PII |
| audit-digest | Mon 08:00 | `/api/cron/audit-digest` | **YES — queues owner mail into `email_outbox`** | owners stop getting the weekly rollup |
| db-partitions | 01:30 on the 1st | `/api/cron/db-partitions` | no | rows fall into `audit_log_default` |

> **`housekeeping` was previously listed here as "no".** That was wrong, and
> the error was load-bearing: on the strength of it, housekeeping was given no
> confirmation requirement and made the dispatch **default**, so the least
> deliberate use of the workflow ran the outbox delivery worker. Classification
> is by transitive runtime behaviour, not by what the job's name suggests.

### Dispatching a cron job by hand

`only` is **required** and has no blank option. It used to default to blank,
and blank ran all five jobs — so the most likely way to use the workflow (open
it, press the button, change nothing) was also the one that mailed every
tenant's customers.

- Only `retention` and `db-partitions` run without confirmation.
- `only` defaults to **`none`**, which starts nothing and fails the run. There
  is deliberately no operational default: every previous default — blank, then
  `housekeeping` — turned "press the button and change nothing" into an action
  that mailed people.
- **`reminders`, `housekeeping`, `audit-digest` and `all` require typing
  `DELIVER-EMAIL-TO-REAL-RECIPIENTS` into the confirm box.** `runReminderTick`
  selects appointments in `[now, now + reminderLeadHours]`, so a dispatch
  really can send mail and SMS to a real customer whose appointment falls in
  that window.
- Getting the confirmation wrong **fails** the run rather than quietly doing
  nothing. A green run that performed no work is the same useless signal this
  runbook exists to prevent.

### Canonical domains and the release header

`bookpitch.ge` serves the deployment directly. **`www.bookpitch.ge` returns a
308 redirect to the apex** — it does not serve the application itself, so any
check against it must follow redirects and read the FINAL response.

`GET /api/health` carries `x-bookpitch-release`, the commit the deployment was
built from (`VERCEL_GIT_COMMIT_SHA`). The response BODY stays exactly
`{"ok":true}`: the monitor treats any extra field there as a leak. The header
exists because the soak controller has to prove the canonical hosts are serving
the exact deployment under soak — before it, the check accepted any HTTP 200,
so a healthy response from a completely different deployment passed.

### audit_log partitions are not reachable by the application role

Row-level security does not inherit downwards. `bookpitch_app` holds **no**
privileges on `audit_log_YYYY_MM` or `audit_log_default`, and each partition
carries its own `tenant_isolation` policy as a second layer. The application
always goes through the parent; PostgreSQL checks privileges on the relation
named in the query, so this costs nothing.

Do not grant on a partition to "make a query work" — it reopens a cross-tenant
read of every organization's audit records. `bp_create_monthly_partition()`
applies both layers at creation; the production invariant check fails if either
is missing.

### Scheduler reliability, and why the lead time has a floor

GitHub does not guarantee scheduled delivery, and this account routinely sees
hours (R-08). Measured 2026-09-01, scheduled events only:

```
00:05  00:27  05:07  06:07  06:24  07:49  10:05  12:26  14:52  17:13  18:08
```

Worst gap **4h40m** against a declared 15 minutes. The reminder window is a
sliding `[now, now + reminderLeadHours]` recomputed each tick, so a lead time
**shorter than the gap between ticks** means appointments are not reminded
late — they are never reminded, because by the next tick they have already
started and left the window. `MIN_REMINDER_LEAD_HOURS` (8) is the floor derived
from that measurement. The 24-hour default has roughly five times the margin it
needs.

If a sub-floor lead time is ever genuinely required, the scheduler has to
change rather than the floor. Supabase `pg_cron` and `pg_net` are available on
this project and were verified installable on 2026-09-01 in a rolled-back
transaction; Vercel Cron on the current Hobby plan is daily-only and cannot
serve this.

`CRON_SECRET` lives in **two** places and must match: Vercel Production and the
GitHub Actions secret. Rotating one without the other produces exactly the
failure seen on 2026-08-16 — every cron run 401s until both sides agree.

```bash
printf '%s' "$NEW" | vercel env add CRON_SECRET production
printf '%s' "$NEW" | gh secret set CRON_SECRET
vercel redeploy <deployment-url>            # Vercel side needs a redeploy
gh workflow run cron.yml                     # prove it before walking away
```

The monitor watches the *symptoms* of each job in the database, not just the
workflow's exit code, because a cron that returns 200 while doing nothing has
happened here before.

It also watches the jobs' own **heartbeats**. Everything the monitor knew about
cron health used to come from the GitHub Actions runs list — "a workflow was
queued and its curl exited 0" — which is a fact about GitHub, not about
Bookpitch, and stays green if the endpoint does nothing. Each job now writes
`cron_heartbeat` on completion, so two different questions have two different
answers:

| `cron-staleness` | `cron-heartbeat-stale` | Reading |
| --- | --- | --- |
| stale | fresh | GitHub is late; the work is happening. Nothing to fix in the app |
| fresh | stale | the schedule arrives and the endpoint does nothing — **the case nothing could previously see** |
| stale | stale | the job is not running at all |

And `cron-manual-verification` is an **INFO** line, excluded from the pass/fail
counts. A `workflow_dispatch` proves the endpoint answers when called; it
proves nothing about schedule delivery. Counting the two together is what let
five manual dispatches displace six failed scheduled runs on 2026-09-01 and
close incident #38 as "recovered".

---

## 8. Monitoring and alert handling

**Workflow:** `.github/workflows/production-monitor.yml`, every 30 minutes.
**Logic:** `scripts/production-monitor.mjs` (dependency-free; no `npm ci`).

Checks, each of which is its own incident class:

| id | Fails when |
| --- | --- |
| `health-endpoint` | `/api/health` is not exactly `{"ok":true}` |
| `production-5xx` | 2+ of 3 probes return 5xx |
| `unexpected-redirect` | the canonical health URL redirects |
| `tls` | certificate invalid or expiring within 14 days |
| `deployment-reachable` | the current Production deployment does not answer |
| `cron-staleness` | no successful cron run in 90 minutes |
| `cron-failures` | 3+ of the last 10 cron runs failed |
| `backup-freshness` | no successful backup in 26 hours |
| `restore-drill-stale` | no successful drill in 40 days |
| `ops-metrics` | `/api/health/ops` is unreachable or non-200 |
| `outbox-dead-letters` | any `email_outbox` row is `dead` |
| `outbox-stale-claims` | a worker died holding a claim |
| `outbox-backlog` | oldest pending row older than 3 hours |
| `housekeeping-stalled` | rows housekeeping should have pruned are still there |
| `retention-stalled` | customers past their window still hold PII |
| `audit-digest-stalled` | the weekly digest queued nothing for 10 days |
| `partition-maintenance` | no future partition, or rows in `audit_log_default` |
| `production-config-incomplete` | a required env var is unset (§2) |

### Alerts

A failing check opens **one** GitHub issue labelled `ops-incident`, titled
`[ops] <check title>`, with a hidden marker `<!-- bookpitch-ops-incident:<id> -->`
in the body. Deduplication matches on that marker, so:

- repeated failures **comment** on the existing issue, and only when the detail
  line has changed — a stable outage stays one quiet issue;
- recovery **comments and closes** the issue automatically;
- an incident whose check is **no longer reported at all** — renamed, removed,
  or only conditionally present — is also closed, but with a different comment
  saying the check is gone rather than claiming a recovery nobody observed;
- renaming the issue does not break deduplication;
- unrelated human-filed issues are never touched.

Alerting runs after the checks and its own failure is reported separately
(exit code 2) so a broken alerter can never be read as a healthy production.

Handling an alert:

```bash
gh issue list --label ops-incident --state open
gh run list --workflow=production-monitor.yml --limit 5
gh run view <run-id> --log | tail -60          # the check table is in the summary
```

Then read the row for that check id in the table above; each maps to a section
of this document.

### Testing the alert path without touching production

```bash
gh workflow run production-monitor.yml -f simulate_failure=drill
gh workflow run production-monitor.yml            # the next healthy run closes it
gh workflow run production-monitor.yml -f alerts=off   # checks only, no issues
```

`simulate_failure` adds one synthetic failing check named
`Monitor alert-path test (synthetic, not a real incident)`. It changes nothing
in production.

### Operational metrics endpoint

`GET /api/health/ops`, bearer `CRON_SECRET`. Returns counts and ages only.
`assertMetricsAreNumericOnly()` fails the request rather than emit a string, so
no address, body, token, IP or tenant identifier can reach a CI log.
`/api/health/ready` is a different endpoint and stays behind a SUPER_ADMIN
session.

---

## 9. Production smoke-test checklist

Run after every deployment. Nothing here writes tenant data.

```bash
# 1. canonical health, exact body, no redirect
curl -sS -w '\n%{http_code} %{num_redirects}\n' https://bookpitch.ge/api/health   # {"ok":true} 200 0

# 2. TLS
curl -sSI https://bookpitch.ge | head -1

# 3. signup page renders
curl -sS https://bookpitch.ge/signup | grep -c 'Create your Bookpitch workspace'  # 1

# 4. bot protection is on: no token must be rejected
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://bookpitch.ge/api/onboard \
  -H 'content-type: application/json' -d '{"email":"x@example.invalid"}'          # 400

# 5. byte limit is real
python3 -c "import json;print(json.dumps({'padding':'x'*200000}))" | \
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://bookpitch.ge/api/onboard \
  -H 'content-type: application/json' --data-binary @-                            # 413

# 6. enumeration safety: identical response for known and unknown
curl -sS -X POST https://bookpitch.ge/api/onboard/resend -H 'content-type: application/json' \
  -d '{"email":"definitely-unknown@example.invalid"}'                             # {"ok":true}

# 7. protected surfaces redirect, never 200
for p in /dashboard /platform /api/customers /api/health/ready; do
  curl -sS -o /dev/null -w "$p %{http_code}\n" "https://bookpitch.ge$p"; done      # all 307

# 8. everything at once
gh workflow run production-monitor.yml
```

**In a browser**, additionally confirm the Turnstile challenge actually solves
on `https://bookpitch.ge/signup`. A missing widget is invisible to every curl
above and is exactly how signup was broken for a week (§12).

Do **not** look for a checkbox. Production's site key is configured as an
invisible/managed widget: nothing appears in the accessibility tree, there is
no visible control, `document.getElementsByTagName('iframe').length` is **0**
because Cloudflare renders inside a closed shadow root, and the submit button
is enabled from the start — the server, not the button, is what refuses a
missing token. Every one of those looks like a broken widget and none of them
is. Checked against the wrong signal on 2026-09-01, and nearly recorded as a
defect.

The signal that actually distinguishes the two is the token:

```js
// paste in the console on /signup, a few seconds after load
const form = document.querySelector('form');
const hidden = Array.from(form.querySelectorAll('input[type=hidden]'));
({
  challengeSolved: hidden.some((i) => (i.value || '').length > 20), // ← must be true
  widgetContainerHeight: Math.round(form.querySelectorAll('div')[3].getBoundingClientRect().height), // 72
  turnstileApiLoaded: typeof window.turnstile?.render === 'function',
});
```

`challengeSolved: false` after ~15 seconds is the outage. The component polls
for `window.turnstile` for that long before giving up — rendering from the
script's `load` event is what failed silently in Phase 13.

---

## 10. Rollback: application versus database

They are different operations and conflating them is how a bad hour becomes a
bad week.

**Application rollback** — code only, no data loss, seconds:

```bash
vercel ls --prod                       # find the last known-good deployment
vercel promote <deployment-url>        # or `vercel rollback`
curl -sS https://bookpitch.ge/api/health
```

Safe whenever the schema has not moved, which the expand-only rule guarantees
for one step back.

**Database recovery** — §6. Slow, lossy up to one day, and a last resort.

Decision rule: if the schema is intact and the data is correct, roll back the
application. Only reach for a restore when data is *wrong*, and never roll the
application back past a migration that removed something.

---

## 11. RTO and RPO

| Scenario | RPO (data loss) | RTO (time to serve) | Path |
| --- | --- | --- | --- |
| Bad deploy, schema unchanged | 0 | ~2 min | `vercel promote` (§10) |
| Bad migration, expand-only | 0 | ~10 min | roll app back, fix forward |
| Data corruption / accidental deletion | **up to 24 h** | 2–4 h | restore latest backup into a new database (§6) |
| Supabase project loss | **up to 24 h** | 4–8 h | new project, restore, repoint `DATABASE_URL*`, redeploy |
| Backup key lost | total | — | unrecoverable; §5 exists to prevent this |

The 24-hour RPO is a direct consequence of daily logical backups on Supabase
Free. Reducing it requires PITR, which requires Supabase Pro — a spending
decision, out of scope here. **State this number to stakeholders explicitly.**

---

## 12. Incident response

1. **Confirm it is real.** `gh workflow run production-monitor.yml`, then read
   the run summary table. One red check with a clear detail line beats guessing.
2. **Classify.** Application (rollback), data (restore), configuration (§2), or
   dependency (Supabase / Resend / Cloudflare status pages).
3. **Contain.** Roll the application back before debugging if users are affected.
4. **Fix the root cause**, not the symptom. Add the test that would have caught
   it — that is the standing rule in CLAUDE.md and it exists because this
   project has repeatedly shipped controls that changed no observable behaviour.
5. **Re-run every affected gate**, redeploy, and re-run the smoke test.
6. **Close the incident issue** or let the next healthy monitor run close it.

### Worked example — the 2026-08-16 signup outage

Symptom: nothing. No alert, no error page, no failing test. Production signup
returned `400 {"error":"invalid request"}` for every request and no
organisation could be created.

Two independent causes, both invisible from outside:

1. `TURNSTILE_EXPECTED_ACTION` and `TURNSTILE_ALLOWED_HOSTNAMES` were never set
   in Vercel Production. `verifyTurnstile()` fails closed on either being
   absent while `NODE_ENV=production`, so no token could ever be accepted.
   Tests set their own environment, so they passed.
2. `SignupForm.tsx` rendered the Turnstile widget from the script's `load`
   event. `window.turnstile` is not guaranteed to exist at that moment; the
   render call was guarded, the guard returned early, and nothing retried.
   Production served a signup page with **zero widget iframes** and a
   permanently disabled submit button.

Fixes: the env vars were added; the widget now polls (bounded) until
`window.turnstile.render` is callable. Regression tests live in
`tests/production-config-contract.test.ts`, and the monitor's
`production-config-incomplete` check now watches the configuration contract so
the first cause cannot recur silently.

The lesson is the one already written in CLAUDE.md: a control that does not
change observable behaviour does not exist. Neither cause was detectable
without loading the real page in a real browser against the real domain.

---

## 13. Email operations

- **Provider:** Resend, `eu-west-1`. **Verified domain:** `send.bookpitch.ge`
  (the apex is deliberately *not* in Resend, to keep its reputation separate).
- **From:** `Bookpitch <no-reply@send.bookpitch.ge>` (`RESEND_FROM`).

DNS (Vercel-managed), verified 2026-08-16:

| Record | Name | Status |
| --- | --- | --- |
| DKIM | `resend._domainkey.send.bookpitch.ge` | present, 1024-bit RSA |
| SPF | `send.send.bookpitch.ge` TXT `v=spf1 include:amazonses.com ~all` | present |
| Bounce MX | `send.send.bookpitch.ge` → `feedback-smtp.eu-west-1.amazonses.com` | present |
| DMARC | `_dmarc.send.bookpitch.ge` `v=DMARC1; p=none; rua=mailto:dmarc@bookpitch.ge` | present |

```bash
dig +short TXT resend._domainkey.send.bookpitch.ge
dig +short TXT send.send.bookpitch.ge
dig +short MX  send.send.bookpitch.ge
dig +short TXT _dmarc.send.bookpitch.ge
```

Open recommendations, each requiring a DNS change (**not authorised here** —
see the Phase 13 ledger § External blockers):

- no organisational DMARC record at `_dmarc.bookpitch.ge`, so the apex has no
  policy of its own;
- DMARC is `p=none` (monitor only); tighten to `quarantine` then `reject` once
  the `rua` reports look clean;
- `rua=mailto:dmarc@bookpitch.ge` has **no MX on `bookpitch.ge`**, so aggregate
  reports are being sent to a domain that cannot receive them.

### Outbox

All durable mail goes through `email_outbox`: onboarding verification, resend,
break-glass alerts, recovery-code notices, impersonation notices, audit digest.
State machine `pending → processing → sent | dead`. Housekeeping drains it
hourly with `FOR UPDATE SKIP LOCKED`, recovers claims whose lease expired,
retries with exponential backoff and jitter computed from the **database**
clock, and gives up at `max_attempts` (default 3) — so a permanently invalid
recipient is retried three times and then dead-lettered, never forever.

Dead rows older than 30 days are swept.

### Dead-letter recovery

The monitor alerts on any `dead` row. To investigate **without reading message
bodies or recipients**:

```sql
-- counts and categories only
SELECT purpose, failure_category, count(*), max(failed_at)
FROM email_outbox WHERE status = 'dead' GROUP BY 1, 2 ORDER BY 3 DESC;
```

To retry a class of failure after fixing the cause:

```sql
UPDATE email_outbox
   SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
       last_error = NULL, failed_at = NULL
 WHERE status = 'dead' AND purpose = '<purpose>' AND failed_at > NOW() - interval '7 days';
```

Then `gh workflow run cron.yml` and confirm the count returns to zero. Never
select `to_address` or `body` — they are encrypted at rest for a reason.

### Testing delivery safely

Use Resend's own sandbox recipients, never a real inbox:

- `delivered@resend.dev` — always accepted and delivered
- `bounced@resend.dev` — always hard-bounces

---

## 14. Synthetic test-data policy

- Every synthetic record is prefixed `E2E-PHASE13-` (or the current phase tag)
  and carries a unique run id.
- Email addresses use `@example.invalid` (RFC 6761 — can never be delivered) or
  a Resend sandbox address. **Never** a real person's mailbox.
- Phone numbers are non-real.
- Synthetic organisations are removed through supported application paths
  (soft-delete / anonymise), never by hand-written production `DELETE`.
- Before and after any production E2E run, record the counts of
  `organizations`, `app_users`, `customers` and `appointments` and diff them.
  Any change to a row that is not tagged synthetic is an incident.

---

## 15. Key rotation

| Secret | Where | Notes |
| --- | --- | --- |
| `CRON_SECRET` | Vercel + GitHub | must be rotated in **both**, then redeploy (§7) |
| `BACKUP_AGE_PRIVATE_KEY` | GitHub + owner copy | keep the old key; see §5 |
| `DATABASE_URL_SUPERUSER_MIGRATE` | GitHub | Supabase dashboard "Reset database password" rotates **only** `postgres` |
| `bookpitch_app` password | Supabase SQL editor | needs an explicit `ALTER USER bookpitch_app WITH PASSWORD` — the dashboard does not do it, and missing it leaves a leaked credential live |
| `AUTH_SECRET` | Vercel | invalidates every session |
| `FIELD_ENCRYPTION_KEY` | Vercel | use `scripts/rotate-encryption-key.ts`; never rotate without it |
| `RESEND_API_KEY` | Vercel + Resend | revoke the old key only after a successful send |

Rules that are not negotiable (CLAUDE.md, F-12 incident):

- never `cat`/`grep`/loop over a file containing secrets;
- read a value into a variable and pipe it via **stdin** — never `--value`;
- parse `.env*` with a language that has real string handling, print keys only;
- rotation scripts do not live in the repository; delete them after use.

---

## 16. Dependency advisories and overrides

CI runs `npm audit --audit-level=high` on the installed tree, after `npm ci`,
and a high or critical finding fails the build. That gate is not optional and
must never be softened to `--audit-level=critical` or wrapped in `|| true`: a
new advisory can land on an unchanged dependency tree at any time, which is
precisely what it exists to catch.

### Active overrides

`package.json` → `overrides`:

| Package | Forced to | Why |
| --- | --- | --- |
| `deepmerge-ts` | `^8.0.1` | [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) — stack exhaustion on recursive object graphs, high severity, published 2026-08-17 |

**How it reached us:** `prisma` (devDependency) → `@prisma/config@7.9.1` →
`deepmerge-ts@7.1.5`, pinned exactly. `prisma@7.9.1` was the latest release and
no upstream fix existed. `npm audit fix --force` wanted to downgrade to
`prisma@6.12.0`, a breaking major change — not acceptable.

**Why the override is safe here:** `@prisma/config` uses exactly one thing from
the package, the `deepmerge` named export, as a merger passed to `c12`
(`node_modules/@prisma/config/dist/index.js`, two call sites). Versions 7.1.5
and 8.0.1 declare the same `exports` map, the same `type: module`, and the same
`engines`. It is also a **development-time** dependency: `prisma` is the CLI,
not the runtime — `@prisma/client` does not depend on `deepmerge-ts` — so
nothing about the deployed application changed.

**Verified after applying it:** `prisma validate`, `prisma generate` and
`prisma migrate status` against production all succeed, which exercises the
config loader and therefore the merger itself; plus the full test suite, lint,
type-check, build, guard scanner and orphan-permission scanner.

**Remove it when** `prisma` ships a release whose `@prisma/config` depends on
`deepmerge-ts >= 8.0.0`:

```bash
npm view prisma version
npm view prisma@latest dependencies                 # check @prisma/config
npm ls deepmerge-ts                                 # confirm the resolved version
# then delete the override, npm install, and confirm:
npm audit --audit-level=high
```

An override that outlives its advisory is a small lie in the dependency tree.
Check this one whenever Prisma is upgraded.

---

## 17. Escalation

| Role | Contact | When |
| --- | --- | --- |
| Owner / primary on-call | Levan Tchanturidze (repo owner) | any P1 |
| Secondary | _unassigned — single-operator project_ | — |
| Supabase | dashboard support, project on Free plan | database unreachable |
| Vercel | dashboard support | deploys failing, DNS |
| Resend | dashboard support | delivery failures |
| Cloudflare | Turnstile dashboard | widget or siteverify outage |

GitHub notifies the owner by assigning incident issues. There is no second
responder: the single-operator gap is a real risk and is recorded as such.

Status pages: `status.supabase.com`, `vercel-status.com`, `resend-status.com`,
`cloudflarestatus.com`.
