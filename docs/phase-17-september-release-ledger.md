# September release — integration, verification and what is actually true

Session date: **2026-09-01**. Working branch `integration/phase16-phase17`,
pull request **#36**.

This ledger records the September integration of Phase 16 and Phase 17 and the
production verification that followed it. It is the authoritative September
record. Where it contradicts an earlier ledger, an entry here says so and gives
the date and the evidence for the change.

Two things are true at once and both matter:

- **the engineering is finished, integrated and CI-verified** — run
  `33494329443`, three green jobs, 1362 unit tests and 265 browser tests;
- **production has no database**, so most production verification could not be
  performed at all — not "was skipped", could not be performed.

**Release decision: the integration is COMPLETE, CI-green, merged as
`e69795b0ea6ff8256c94f2f6722f94013f4c7234` and deployed to production as
`dpl_87yRocWWmb2eyrwwpsrrzv5z6czn`. The release is NOT production-verified.** Three things are externally blocked and none of them can
be cleared from inside this repository: a Supabase credential (§2), a Sentry DSN
(§12), and a GitHub plan that allows branch protection (§11).

---

## 0. Repository truth at the start of the session

Every historical reference in the brief was re-derived rather than assumed.

| | Brief said | Actually was |
|---|---|---|
| `origin/main` | `dae46ac` | `dae46ac` — confirmed |
| Phase 17 HEAD | `92ba247` | `92ba247` — confirmed |
| Integration HEAD | `00a5d76` | `00a5d76` — confirmed |
| Integration vs main | 31 ahead / 3 behind | 31 ahead / 3 behind — confirmed |
| PR #36 | open | open, `MERGEABLE`, `UNSTABLE` |
| PR #35 | open | open |
| Migrations | 63 | 63 (+ `migration_lock.toml`) |
| Actions billing | suspended | **restored** — see §1 |

The three commits `main` held that the integration branch did not
(`70ca5ab`, `4a79678`, `dae46ac`) pause and then restore the recurring
schedules. `git diff 5c8fb77 origin/main` is **empty**: their net tree change is
nothing. They were merged in for history, not content, so the branch is
genuinely up to date before the release merge (`ceeb9a9`).

---

## 1. The first hard gate — GitHub Actions really executes

A failed job with zero steps is a billing symptom, not a product signal. The
transition is visible to the minute:

| Run | Workflow | Created | Steps in job 1 |
|---|---|---|---|
| `33437304861` | CI (push, main) | 2026-08-31T20:40:22Z | **0** |
| `33438595954` | CI (PR #36) | 2026-08-31T20:55:02Z | **0** |
| `33453316896` | Scheduled crons | 2026-09-01T00:05:06Z | **3** |
| `33455049387` | Production monitor | 2026-09-01T00:30:44Z | **5** |

Actions billing was restored between **2026-08-31T20:55Z** and
**2026-09-01T00:05Z**. Every run from that point starts, checks out, and runs
real steps. `GATE PASSED`.

---

## 2. P0 — production has no database

Found while reading why four scheduled workflows were failing. Investigated
read-only.

**The Supabase project behind production no longer exists.**

| Probe | Result |
|---|---|
| Vercel runtime log, production `dpl_92gL3DZr6kZLomHK3C1fukxd6F1r`, `GET /book/…` | `PrismaClientKnownRequestError XX000: (ENOTFOUND) tenant/user postgres.cglqphbebckvpeyisqqb not found` |
| `psql` → `aws-0-eu-central-1.pooler.supabase.com` :5432 and :6543 | `FATAL: (ENOTFOUND) tenant/user … not found` |
| `psql` → `aws-1-eu-central-1.pooler.supabase.com` :5432 and :6543 | identical |
| DNS `db.cglqphbebckvpeyisqqb.supabase.co` | `NXDOMAIN` |
| DNS `cglqphbebckvpeyisqqb.supabase.co` | `NXDOMAIN` |

A *paused* Supabase project still resolves. `NXDOMAIN` on the project host, on
both poolers and both ports, is a project that is gone.

### What still works, and why that is misleading

`https://bookpitch.ge/api/health` returns `200 {"ok":true}` and always will:
`app/api/health/route.ts` is a process-liveness probe that deliberately touches
nothing. TLS is valid to 2026-11-10. Static routes render. **The site is up and
cannot read or write anything.** `GET /book/<any-slug>` → 500,
`/api/cron/retention` → 500, `/api/health/ops` → 503.

### The data is not lost

Restore drill **run `33491958258`**, dispatched 2026-09-01T09:23:23Z against the
newest surviving artifact `production-backup-32546836760-1` (taken
2026-08-22T02:40:04Z, 298,429 bytes, retained to ~2026-09-26), into a disposable
PostgreSQL 17 container — **success**, 13 steps:

```
checksum ok: aad244c58500b8086ad32278ee575c028e10d15c47ee73dc66ef0c754b95be0c
decrypted dump: 243645 bytes · table of contents: 547 entries
pg_restore completed with no errors
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
```

This is a lost **host** with a proven recovery point, not lost data. Anything
written after 2026-08-22T02:40Z is not in it.

### The exact external action required

Only the account owner can do this; no Supabase credential exists in this
repository, in CI, or in Vercel's readable configuration.

1. Create or restore a Supabase PostgreSQL project.
2. Restore the 2026-08-22 backup into it (`docs/backup.md` § Restoring).
3. `ALTER USER bookpitch_app WITH PASSWORD …` — Supabase's dashboard reset
   rotates only `postgres`, never the runtime NOBYPASSRLS role.
4. Vercel Production: `DATABASE_URL`, `DIRECT_URL`, `ADMIN_DATABASE_URL`,
   `DATABASE_URL_LOGIN`, `DATABASE_URL_SUPERUSER_TXPOOL`.
5. GitHub Actions secrets: `DATABASE_URL_SUPERUSER_MIGRATE`,
   `ADMIN_MIGRATE_DATABASE_URL`.
6. Redeploy, then run `.github/workflows/migrate.yml`. The restored dump is at
   62 migrations; `main` carries 63.

Incidents #37, #38, #39 and #40 are all this, and all close automatically once
`/api/health/ops` answers.

---

## 3. Incident #26 was closed by blindness, and that is now a fixed defect

At `2026-09-01T00:31:06Z` the monitor closed **#26** —
`production-config-invalid`, the P0 where production's `FIELD_ENCRYPTION_KEY`
was set without its `<key-id>:` prefix — with "this check is no longer reported
by the monitor".

The check had not been removed. `/api/health/ops` was answering 503 (§2), so
`evaluateOpsMetrics()` never ran and none of its ten ids reached the reconciler.
**Absent was read as gone, and gone was read as resolved** — on the one incident
class that had already caused a P0.

Fixed in `e913f83`, and now on `main`. `reconcileIncidents` separates *gone*
(close as orphan) from *unobservable* (keep open, say why).

**Verified by test, not yet observable in production.** The fix only changes
behaviour while an ops-derived incident is open, and none is: #26 is closed and
the four live incidents (#37–#40) are all base checks. Four complement
assertions cover both halves — recovery still closes as recovery, a genuinely
removed check still closes as an orphan, a removed check absent during an ops
outage still closes as an orphan, and the id list must match the evaluator. The exemption is scoped to
`OPS_DERIVED_CHECK_IDS`, which is asserted against `evaluateOpsMetrics()` itself
rather than hand-maintained — and that assertion failed on its first run, because
the list said `audit-digest-stale` and the evaluator emits `audit-digest-stalled`.

**Status of the underlying condition: `NOT VERIFIED`.** The malformed key was
replaced on 2026-08-22, but no monitor run has ever confirmed it: every run
between then and 2026-08-31T20:55Z had zero steps, and every run since has been
unable to reach `/api/health/ops`. Vercel marks the variable Sensitive, so
`vercel env pull` returns it empty and its structure can only be validated by the
running application. #26 is left closed with a comment recording exactly this;
reopening would only have it auto-closed again for the same reason.

---

## 4. P17-013 — fixed, not deferred again

Phase 17 recorded this as a known gap for Phase 18. It was fixable, so it was
fixed (`825dfaa`).

Measured against `next start`, seeded MARKETING account:

| Route | Before | After |
|---|---|---|
| `/scheduler` | 500, "Something went wrong" | **403**, Operational Access Lock |
| `/audit` | 500 | **403** |
| `/settings` | 500 | **403** |
| `/patients` | 500 | **403** |
| `/analytics` | 200 | **200** |
| `GET /api/appointments` | 403 JSON | **403 JSON, unchanged** |
| `GET /api/customers` | 403 JSON | **403 JSON, unchanged** |
| anonymous `/scheduler` | 307 → `/signin` | **307 → `/signin`** |

ORG_OWNER control after the change: `/scheduler` 200, `/patients` 200,
`/audit` 200, `/analytics` 200.

The refusal was always correct — `rbac.enforce_deny` fired and no tenant data
rendered. The user was told the wrong thing, and could not have been told the
right one: `app/(app)/error.tsx` dispatched on `error.name === 'ForbiddenError'`
and Next strips the name from errors forwarded to the client in a production
build, so that branch was dead in the only environment with users.

`lib/rbac/page-guard.ts` adds `requirePagePermission`, identical in decision and
different only in transport: it calls Next's `forbidden()`, so Next renders the
nearest `forbidden.tsx` with a 403 and a `noindex` tag. Route handlers keep
`requirePermission` deliberately — `withApi` catches `ForbiddenError` to build
its JSON body, and a `try/catch` around an interrupt is the documented way to
lose it.

`experimental.authInterrupts` is enabled in `next.config.ts`. It is still
flagged experimental in Next 16.3.0 (introduced 15.1.0); the flag only makes the
API callable and changes nothing else, and without it `forbidden()` throws a
plain Error and the 500 comes silently back — which is why
`tests/phase17-forbidden-boundary.test.ts` asserts the flag is present.

`app/platform/layout.tsx` deliberately keeps the old form: it catches and
redirects an org-plane caller to `/`, which is a wrong-plane routing decision
rather than a denial. `app/platform/forbidden.tsx` covers the other case.

### A vacuous complement, found by fixing the thing it was hiding

`e2e/journeys/forbidden-access.spec.ts` asserted that MARKETING **can** reach
`/patients`, as the complement proving the denial tests were not vacuous.
F16-012 had already revoked `client.read:contact` from MARKETING, so it could
not — and the test passed anyway, because the 500 error page keeps the URL,
still renders inside `<main>`, and never contained the words the test looked
for. Three assertions, all satisfied by the exact denial they were written to
rule out. `/patients` is now asserted as a denial; `/analytics`, which MARKETING
genuinely holds, is the complement.

---

## 5. Two checkers that would have reported fiction

`requirePagePermission` is a new name, and two checkers matched the old one
literally:

- `scripts/check-guards.ts` — a page guarded **only** by the page form would
  have read as unguarded. (It did not fire, because every converted page also
  calls `requireAuthContext`; the name is listed explicitly so it cannot start
  mattering silently.)
- `scripts/check-orphan-perms.ts` — a permission enforced only by a page would
  have been reclassified `ORPHAN` and failed CI for a rename.
- `tests/phase16-nav-permission-parity.test.ts` — the F16-003 parity guard
  scanned for `requirePermission(` and reported "no requirePermission() call" for
  eight pages that were guarded the whole time.
- `tests/route-access.test.ts` — asserted `rejects.toBeInstanceOf(ForbiddenError)`.
  It now asserts the 403 interrupt digest, which is the refusal a user receives.

---

## 6. F16-011 — lint warnings recomputed

**19 warnings, 0 errors → 5 warnings, 0 errors** (`8fca05c`). Fourteen removals,
each behaviour-preserving and verified against its callers.

The five retained are all React Compiler findings in client components, and all
five need a behavioural change to silence:

| File | Warning | Why it stays |
|---|---|---|
| `components/patients/PatientList.tsx:174` | setState in an effect | fetch-on-mount then poll; a rewrite changes when the first fetch happens |
| `components/scheduler/SchedulerView.tsx:753` | setState in an effect | same |
| `components/shell/useNotifications.ts:59` | setState in an effect | same |
| `components/platform/OrgDetail.tsx:346` | `Date.now()` during render | "days to renewal"; moving it out risks a hydration mismatch on a value that is currently correct |
| `components/platform/OrgList.tsx:31` | `Date.now()` during render | "signups in the last seven days"; same |

---

## 7. The first CI run of this work found two real defects

CI run `33491923279` is the first time GitHub Actions has ever executed the
Phase 16 and Phase 17 suites. Both failures were green on a laptop and red on a
runner.

**`ADMIN_DATABASE_URL` is not a CI variable** (`6863262`). Two suites open a
second connection outside Prisma's pool and both read it; on a runner the
privileged URL is `DATABASE_URL_SUPERUSER_SESSION`. `phase16-session-expiry-db-clock`
threw outright; `phase17-reminder-boundary` connected with `undefined`, fell back
to libpq's unix-socket defaults, and turned three P17-005 boundary assertions
into `expected 'failed' to be 'sent'`. `tests/helpers/admin-db-url.ts` resolves
it once, refuses to fall back to `DATABASE_URL` — the NOBYPASSRLS role, under
which the lock probe would see no rows, take no lock and answer "lockable" every
time — and a scan asserts no test builds a privileged connection string from
`process.env` again.

**A 320px overflow that reproduces only on Linux.** Four
`authenticated-mobile-320` tests failed with "overflows by 143px", against pages
that measure 0px of overflow on macOS at 305, 310 and 320px. The spec now names
the offending elements when it fails; §12 records the outcome.

---

## 8. Local verification

Run against a disposable PostgreSQL 16 database, recreated from empty, with the
application role's password set exactly as `ci.yml` does so RLS assertions
actually fire. (An earlier run that skipped that step produced 30 "failures"
that were the superuser bypassing RLS — recorded here because the *shape* of
that mistake is the one this repository keeps finding.)

| Gate | Result |
|---|---|
| `prisma validate` | pass |
| `prisma migrate deploy` | **63** migrations applied, 0 unfinished |
| `prisma migrate diff --exit-code` | no difference |
| `db:seed` | pass |
| `bookpitch_app` role attributes | `rolsuper=false, rolbypassrls=false` |
| `bookpitch_app` UPDATE on `audit_log` | `f` (revoked) |
| RLS / FORCE RLS inventory | 20 tables with RLS, 20 with FORCE RLS |
| public tables | 49 |
| `format:check` | pass |
| `lint` | 0 errors, 5 warnings |
| `tsc --noEmit` | pass |
| `vitest run` | **1362 / 1362** across **109** files |
| `check-guards` | 105 entry points, 18 allow-listed, all guarded |
| `check-orphan-perms` | 67 seeded = 40 enforced + 27 deferred + **0** orphan + **0** inconsistent |
| `check-unreachable-components` | 128 entry points, all reachable |
| `npm audit --audit-level=high` | pass |
| `npm run build` | pass |
| `e2e:seed` | 9 identities |
| `playwright test` | 265 passed, 3 skipped, 268 total |
| `e2e:check` | all 9 required projects executed |

Comparison with the historical integration evidence: 1341 → **1362** tests
(+21: the P17-013 boundary suite, the admin-URL suite, four monitor
blindness assertions, one e2e split); 107 → **109** files; every other number
unchanged.

### Permission accounting (P17-006)

`67 seeded = 40 ENFORCED + 27 EXPLICITLY_DEFERRED + 0 ORPHAN + 0 INCONSISTENT`,
unchanged by the integration. The five keys called out in the brief:

| Key | Classification |
|---|---|
| `org.delete` | `EXPLICITLY_DEFERRED` — bundle `org_self_delete` |
| `platform.billing.manage` | `EXPLICITLY_DEFERRED` — bundle `platform_billing` |
| `clinical_note.create` | `EXPLICITLY_DEFERRED` — bundle `clinical_notes` |
| `clinical_note.attachment.manage` | `EXPLICITLY_DEFERRED` — bundle `clinical_note_attachments` |
| `clinical_note.read:own` | `EXPLICITLY_DEFERRED` — bundle `clinical_notes` |

No deferred product was built to satisfy the checker.

### Durable-email inventory (P17-002 / P17-003)

Every remaining `provider.send()` callsite, classified:

| Callsite | Pattern | Verdict |
|---|---|---|
| `lib/messaging/outbox.ts:166` | the outbox drain itself | the durable path |
| `lib/housekeeping.ts:263` | drains outbox rows | durable |
| `lib/onboarding.ts:500` | claim row → commit → send | durable, hand-rolled |
| `lib/platform/break-glass.ts:287` | claim row → commit → send | durable, hand-rolled |
| `lib/platform/mfa.ts:537` | claim row → commit → send | durable, hand-rolled |
| `lib/messaging/reminders.ts:233,237` | claim → commit → send → persist | **deliberately direct** — reminders own their claim/lock design (P17-004/005) and `message_log` is the durability record |
| `lib/admin/ownership-transfer.ts:106` | direct, failure logged and swallowed | **retained** — the nominee also gets an in-app notification and a `sessionVersion` bump, so a lost email is not a lost nomination. Recorded as P2, not migrated at the end of a release. |

Password reset and invitations — the two P17-002/P17-003 targets — go through
the outbox and are not in this list.

---

## 9. Commits on the integration branch

| SHA | Concern |
|---|---|
| `ceeb9a9` | merge current `main` — history, not content |
| `825dfaa` | P17-013 — a denied page is a 403 with a denial screen, not a 500 |
| `8fca05c` | F16-011 — lint warnings 19 → 5, the five retained ones classified |
| `e913f83` | monitor — stop reading blindness as an all-clear (incident #26) |
| `6863262` | CI — give a private database session the URL a runner actually sets |
| `1e31511` | shell — let the location switcher shrink instead of widening the document |
| (final) | documentation reconciliation — this ledger and every stale claim it corrects |

Grouped by concern, not by file. The Phase 16 and Phase 17 histories underneath
are untouched: no squash, no rebase, no rewrite of `14f7c26` or `92ba247`.

---

## 10. CI evidence

Required checks, on the exact head SHA. A job with zero steps was never
accepted as a result.

**Run `33494329443`** on `1e315111ee2ef91998ededb0a00e430629d1cf46`, PR #36,
2026-09-01T09:50:40Z → 09:58:10Z. **All three required checks green.**

| Job | Conclusion | Steps executed |
|---|---|---|
| Secret scanning | success | 5 (5 success) |
| Lint, type-check, test, and build | success | 25 (25 success) |
| Browser, mobile, and accessibility suite | success | 22 (21 success, 1 skipped — the failure-only report upload) |

Measured inside those jobs:

| | |
|---|---|
| gitleaks | 22 commits, ~239 KB, **no leaks found** |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| migrations | **63** found, applied, `No difference detected` on strict drift |
| `bookpitch_app` | `OK: NOSUPERUSER NOBYPASSRLS`, `OK: no UPDATE on audit_log` |
| vitest | **1362 passed (1362)** across **109 passed (109)** files, 118.90s |
| guard checker | 105 entry points, 18 allow-listed, all guarded |
| orphan permissions | 67 = 40 enforced + 27 deferred + 0 orphan + 0 inconsistent |
| reachability | 128 Next.js entry points |
| build | compiled successfully in 28.5s |
| Playwright | **265 passed, 3 skipped**, 4.3m |
| `e2e:check` | **all 9 required suites executed (268 tests total)** — `authenticated` 49, `authenticated-mobile-320` 6, six public projects 34 each, `setup` 9 |

One line worth quoting from the browser job, because it is F16-002 refusing in
the environment it was written for:

```
auth.platform_login_alert_failed — EMAIL_PROVIDER must be set in production
                                   — refusing to default to the mock provider
```

### The two runs before it, and why they are in the record

| Run | Head | Result |
|---|---|---|
| `33491923279` | `8fca05c` | **failure** — `ADMIN_DATABASE_URL` unset on the runner (4 suites), and the 320px overflow (4 tests) |
| `33493192086` | `6863262` | **failure** — unit suite green; the 320px overflow remained, now naming its offender |
| `33494329443` | `1e31511` | **success** |

Neither failure was infrastructure. Both were real defects in code that had
passed on a laptop, and both are fixed with a test that fails without the fix.

---

## 10a. Merge and deployment

**Merged 2026-09-01T10:06:52Z.**

| | |
|---|---|
| Starting `main` | `dae46acfc25b42360e369b28c6ea51ab2b72a287` |
| Final integration head | `1b4f26ecde044394b01a29abb3a7a139e7d7d7fd` |
| Pull request | **#36** |
| Merge commit | **`e69795b0ea6ff8256c94f2f6722f94013f4c7234`** |
| Parents | `dae46ac` + `1b4f26e` — a merge commit, not a squash |
| Final `main` | `e69795b0ea6ff8256c94f2f6722f94013f4c7234` |
| Commits added to `main` | 39 |
| Working tree | clean |

Squashing would have collapsed 38 commits — the whole Phase 16 and Phase 17
history — into one. The brief asks that the trail be preserved, so `--merge`
was used even though this repository's previous PRs were squashed.

**PR #35 reconciled as merged, not closed.** Its head `92ba247` is an ancestor
of `main`; GitHub attributed it to `86e09a95`, the integration merge that
brought Phase 17 in, and marked #35 `MERGED` at 10:06:54Z on its own. A comment
records what changed between that PR and what landed.

### CI on the merged `main`

Run **`33495733305`** (push, `e69795b0`) — **success**.

### Production deployment

| | |
|---|---|
| Deployment id | **`dpl_87yRocWWmb2eyrwwpsrrzv5z6czn`** |
| URL | `https://bookpitch-gp8csbakw-padelebi-s-projects.vercel.app` |
| Target | production, region `fra1` |
| Source SHA | **`e69795b0`** — equal to the merged `main` |
| Created | 2026-09-01T10:06:56Z, Ready after ~1m |
| Aliases | `bookpitch.ge`, `www.bookpitch.ge`, `bookpitch1.vercel.app`, `bookpitch-git-main-…` |

Git-triggered from the merge, which is this repository's established mechanism —
no deployment was made from an unmerged branch. Independently confirmed by the
monitor itself, which resolves the deployed SHA rather than trusting Vercel:

```
PASS  deployment-reachable     deployment e69795b responded 200
```

### Migrations after deployment

`.github/workflows/migrate.yml` fired on the merge (migration 63 is new to
`main`) and **failed at "Apply migrations"**, opening issue #41:

```
Datasource "db": PostgreSQL database "postgres" at aws-0-eu-central-1.pooler.supabase.com:5432
Error: Schema engine error:
FATAL: (ENOTFOUND) tenant/user postgres.cglqphbebckvpeyisqqb not found
```

This is the correct outcome and it is recorded as a failure, not explained away:
**production's migration state is unknown and migration 63 is not applied**. The
workflow must be re-run after the database is restored — the 2026-08-22 dump is
at 62, `main` is at 63.

### Manual dispatch, post-deployment

Production monitor run **`33496578517`** (`workflow_dispatch`, `alerts=off`),
5 real steps, **6/10 checks passed**:

```
PASS  health-endpoint       3/3 probes returned 200 {"ok":true}
PASS  production-5xx        0/3 probes returned 5xx
PASS  unexpected-redirect   no redirects on the canonical health URL
PASS  tls                   certificate valid until 2026-11-10 (69 days remaining)
PASS  deployment-reachable  deployment e69795b responded 200
FAIL  cron-staleness        Scheduled crons: no successful run found at all
FAIL  cron-failures         10/10 recent cron runs failed
FAIL  backup-freshness      last success 247.6h ago, limit 26.0h
PASS  restore-drill-stale   last success 0.9h ago (run 33491958258), limit 960.0h
FAIL  ops-metrics           /api/health/ops returned 503
```

Ten checks, not twenty: the ten `/api/health/ops` feeds were not evaluated. That
is the distinction §3 exists to preserve.

### Production probes against the new deployment

| | |
|---|---|
| `/api/health` | 200 |
| `/privacy` | 200 |
| `/signin` | 200 |
| `/` | 307 → `/signin`, no loop |
| `/api/health/ops` unauthenticated | 401 |
| `/book/<unknown-slug>` | **500** — no database |

### Recovery branches retained

`agent/phase-17-stabilization` and `integration/phase16-phase17` are **not**
deleted, and `delete_branch_on_merge` is off. They stay until production
verification and the soak are complete.

---

## 11. Branch protection — EXTERNALLY BLOCKED (account level)

Attempted, with the three real check names read off a completed run:

```
PUT /repos/levantchanturidze/bookpitch/branches/main/protection
  required_status_checks.strict = true
  contexts = ["Secret scanning",
              "Lint, type-check, test, and build",
              "Browser, mobile, and accessibility suite"]
  enforce_admins = false, allow_force_pushes = false, allow_deletions = false
→ 403 {"message":"Upgrade to GitHub Pro or make this repository public
        to enable this feature."}
```

`GET .../branches/main/protection` and `GET .../rulesets` return the same 403.
This repository is **private on a free personal account**, and GitHub gates both
branch protection and rulesets behind Pro (or making the repository public) for
private repositories.

This is not a new discovery — `docs/phase-15-risk-register.md` R-07 already
recorded it as an accepted risk. It is re-attempted and re-recorded here because
the brief asked for protection to be configured, and "accepted in August" is not
the same as "still impossible in September".

No substitute was invented. A workflow that complains about a direct push after
it has landed is not protection, and adding one would create the appearance of a
control that does not exist — which is the specific failure mode this repository
has been correcting all phase.

**The single external action:** upgrade the account to GitHub Pro (or move the
repository to an organisation on a plan that includes rulesets), then apply the
`PUT` above verbatim. Do not make the repository public to obtain it.

Until then, the release path is: branch → PR → all three checks green → merge
button. That was followed for this release; it is convention, not enforcement.

---

## 12. Sentry — EXTERNALLY BLOCKED (missing credential)

The code is complete and was verified as far as it can be without a DSN:

- `instrumentation.ts` registers the server and edge configs and re-exports
  `captureRequestError` as `onRequestError`;
- `instrumentation-client.ts` initialises the browser SDK behind
  `NEXT_PUBLIC_SENTRY_DSN`, dynamically so the 61 KB SDK is not shipped to
  every visitor while no DSN exists;
- `scripts/verify-sentry.mjs` refuses to collapse "configured", "initialised",
  "emitted" and "received" into one claim, and exits non-zero at level 1
  without a DSN;
- the monitor counts the gap as its own check,
  `production-observability-unconfigured`, deliberately separate from
  `production-config-incomplete` — "we are blind" and "we are down" must not
  share a status line.

**No DSN exists anywhere.** `vercel env ls production` lists
`SENTRY_ENVIRONMENT` and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` and neither
`SENTRY_DSN` nor `NEXT_PUBLIC_SENTRY_DSN`. `gh secret list` returns five
secrets, none of them Sentry. No local env file contains one.

Levels 3 and 4 — event emitted, event received — therefore have no evidence and
are recorded as `NOT VERIFIED`, not as passing. No temporary diagnostic route
was deployed to production; `verify:sentry` is a CLI precisely so that none is
needed.

**The single external action:** create the Sentry project, then set `SENTRY_DSN`
and `NEXT_PUBLIC_SENTRY_DSN` in Vercel Production and run
`SENTRY_DSN=… npm run verify:sentry` until it reports level 4 with an event id.

---

## 13. Production verification — what was possible and what was not

`https://bookpitch.ge`, 2026-09-01.

| Check | Result |
|---|---|
| canonical domain resolves, TLS valid | PASS — certificate valid to 2026-11-10 |
| `/api/health` | PASS — `200 {"ok":true}` |
| `/privacy`, `/terms` | PASS — 200, public, no session |
| `/` and `/sign-in` | PASS — 307 → `/signin`, which renders 200. No loop. |
| `/api/health/ops` without a bearer | PASS — `401 {"error":"unauthorized"}` |
| `/api/health/ops` with the monitor's bearer | **FAIL — 503**, no database |
| `/book/<unknown-slug>` | **FAIL — 500**, no database (should be a 404) |
| `/api/cron/retention` | **FAIL — 500**, no database |
| `POST /api/auth/reset/request`, known vs unknown address | Identical `500` with an empty body for both. Enumeration-safe by accident of the outage, **not** verified as designed — the branch that must answer identically never ran. `NOT VERIFIED`. |
| `/reset` page | PASS — 200 (static) |
| Onboarding, encryption round-trip, RBAC landing in production | **NOT POSSIBLE** — every one needs the database |
| Password reset / invitation reaching the outbox in production | **NOT POSSIBLE** — same |
| Production backup | **FAIL** — run `33478913883`, `tenant/user … not found` at the dump step |
| Restore drill | **PASS** — run `33491958258`, §2 |
| Sentry event ingestion | **NOT VERIFIED** — no DSN, §12 |

No synthetic production tenant was created. With no database it would have
failed at the first write, and with a database it would still have needed the
designated test mailbox that `docs/production-uat-checklist.md` requires and
that has never been designated. The E2E Turnstile credential was **not**
deployed to production and must not be: `lib/auth/e2e-runtime.ts` gates it on a
loopback `APP_URL`, which `https://bookpitch.ge` can never satisfy, and
`tests/phase17-turnstile-bypass.test.ts` requires a refusal for exactly that
production-shaped case.

---

## 14. The 24-hour soak has NOT started

The clock starts at the first fully successful production monitor run. There has
not been one, and there cannot be one while four checks fail for a cause outside
this repository. Nothing here is soak evidence, and none of it is presented as
such.

When the database is restored, that restore is itself a material production
configuration change: start from step 1 of
`docs/phase-15-actions-restoration-runbook.md`, and start the clock at the first
monitor run that reports **20/20**, not at the deployment's Ready time.

The automation the soak needs is already in place and already running on
schedule — production monitor every 30 minutes, crons on their six schedules,
backup nightly at 01:40 UTC. No new implementation is required to continue; the
soak resumes on its own the moment the underlying failure clears.

---

## 15. Phase matrix

Five columns, because "done" has been meaning five different things.

- **Impl** — implemented in code.
- **Main** — merged into `main`.
- **Prod** — deployed to production.
- **Verified** — observed working in production.

Status values: `DONE`, `PARTIALLY DONE`, `NOT DONE`, `SUPERSEDED`,
`NOT VERIFIED`, `EXTERNALLY BLOCKED`.

### Phase 15

| Item | Status | Impl | Main | Prod | Verified | Evidence |
|---|---|---|---|---|---|---|
| P15-001 public legal surface | DONE | ✔ | ✔ | ✔ | ✔ | `/privacy` and `/terms` return 200 to a signed-out visitor, 2026-09-01 |
| P15-002 complete insurance PII erasure | DONE | ✔ | ✔ | ✔ | ✖ | `tests/insurance.test.ts`, `tests/gdpr.test.ts`; production needs a database |
| P15-003 actionable audit-digest monitoring | DONE | ✔ | ✔ | ✔ | ✖ | `evaluateAuditDigest` + its tests; the check is ops-derived, so unobservable now |
| P15-004 reliable digest scheduling | DONE | ✔ | ✔ | ✔ | ✖ | `cron.yml` `3 * * * *` present and dispatching; the endpoint 500s |
| P15-005 treatment-history retention | EXTERNALLY BLOCKED | — | — | — | — | Legal decision, unchanged. Safest current behaviour retained: erasure does not touch `treatment_history`, and the privacy notice says so. |
| P15-006 Playwright runs in CI | SUPERSEDED | ✔ | ✔ | n/a | ✔ | Replaced by the stronger P17-011 design; 9 projects, 268 tests, zero-test guard |
| P15-007 load test cannot target production | DONE | ✔ | ✔ | n/a | ✔ | `load-test.yml` gates on `STAGING_URL` |
| P15-008 disposable-database guard | DONE | ✔ | ✔ | n/a | ✔ | `tests/setup.ts` allow-list; `tests/phase15-db-guard.test.ts` proves the refusal |
| P15-009 durable, idempotent audit digest | DONE | ✔ | ✔ | ✔ | ✖ | queued through the outbox; production needs a database |
| P15-010 malformed `FIELD_ENCRYPTION_KEY` | NOT VERIFIED | ✔ | ✔ | ✔ | ✖ | Corrected 2026-08-22; the only validator is `/api/health/ops`, which cannot answer. §3 |
| P15-011 incidents are assigned | DONE | ✔ | ✔ | n/a | ✔ | #37–#40 opened assigned, 2026-09-01 |
| P15-012 test isolation | DONE | ✔ | ✔ | n/a | ✔ | advisory suite lock; `tests/phase15-suite-lock.test.ts` proves it is held |
| P15-013 DNS interpretation | DONE | ✔ | ✔ | n/a | ✔ | retraction recorded in the risk register R-01 |
| Production UAT | NOT DONE | — | — | — | — | Blocked by R-20; also still needs a designated test mailbox |
| 24-hour soak | NOT DONE | — | — | — | — | §14 |

### Phase 16

| Item | Status | Impl | Main | Prod | Verified | Evidence |
|---|---|---|---|---|---|---|
| F16-001 mock payment gateway unreachable in production | DONE | ✔ | ✔ | ✔ | ✖ | production-shaped tests fail closed; no production request path to exercise |
| F16-002 messaging providers fail closed | DONE | ✔ | ✔ | ✔ | ✔ | observed live in CI: `auth.platform_login_alert_failed — EMAIL_PROVIDER must be set in production — refusing to default to the mock provider` |
| F16-003 nav ↔ route permission parity | DONE | ✔ | ✔ | n/a | ✔ | `tests/phase16-nav-permission-parity.test.ts`, taught the new guard name (§5) |
| F16-004 unreachable components removed | DONE | ✔ | ✔ | n/a | ✔ | 128 entry points scanned, all reachable |
| F16-005 assistant model fallback | DONE (deliberate) | ✔ | ✔ | ✔ | n/a | revalidated; no evidence the fallback is unsafe, so unchanged |
| F16-006 mocked providers visible to the config contract | DONE | ✔ | ✔ | ✔ | ✖ | ops-derived check, unobservable while the DB is down |
| F16-007 role-by-surface matrix | DONE | ✔ | ✔ | n/a | ✔ | regenerated from the live role inventory by `tests/role-landing.test.ts` |
| F16-008 bounded patient loading | DONE | ✔ | ✔ | ✔ | ✖ | pagination boundary tests pass; production needs a database |
| F16-009 / F16-010 database-clock semantics | DONE | ✔ | ✔ | ✔ | ✖ | `tests/phase16-session-expiry-db-clock.test.ts` — **first run against a non-UTC session on a runner**, after `6863262` |
| F16-011 lint warnings | DONE | ✔ | ✔ | n/a | ✔ | 19 → 5, the five classified (§6) |
| F16-012 MARKETING least privilege | DONE | ✔ | ✔ | ✔ | ✖ | migration `20260823000001` + seed + `role-denials.ts`; browser-verified in CI (403 on `/patients`), not in production |

### Phase 17

| Item | Status | Impl | Main | Prod | Verified | Evidence |
|---|---|---|---|---|---|---|
| P17-001 role landing contract | DONE | ✔ | ✔ | ✔ | ✖ | MARKETING → `/analytics`; `tests/role-landing.test.ts` fails if a new role has no landing |
| P17-002 durable password-reset mail | DONE | ✔ | ✔ | ✔ | ✖ | outbox row written in the same transaction, idempotency key, bounded retry, dead-letter |
| P17-003 durable invitation mail | DONE | ✔ | ✔ | ✔ | ✖ | as above |
| P17-004 reminder duplicate race | DONE | ✔ | ✔ | ✔ | ✖ | concurrent claim yields `['sent','skipped_duplicate']`, never `['sent','sent']` |
| P17-005 transaction boundary + bounded fan-out | DONE | ✔ | ✔ | ✔ | ✖ | lock probe proves no transaction is held across the provider call — **first honest run on a runner**, after `6863262` |
| P17-006 permission accounting | DONE | ✔ | ✔ | n/a | ✔ | 67 = 40 + 27 + 0 + 0; the checker taught the new guard name (§5) |
| P17-007 Sentry and observability | EXTERNALLY BLOCKED | ✔ | ✔ | ✔ | ✖ | levels 1–4 separated; no DSN exists. §12 |
| P17-009…P17-012 authenticated E2E | DONE | ✔ | ✔ | n/a | ✔ | 9 projects, 268 tests, zero-test guard; 320px overflow fixed for real this time (§7, `1e31511`) |
| P17-013 production authorization UX | DONE | ✔ | ✔ | ✔ | ✖ | 500 → 403 with the denial screen; measured both ways (§4) |
| P17-014 / P17-015 documentation truth | DONE | ✔ | ✔ | n/a | ✔ | the 100-row `audit_log` conclusion still holds — the restore drill read the same 100 rows out of the 2026-08-22 dump |

---

## 16. Residual risks

Separated by what would actually resolve them, because "risk" has been covering
four different kinds of thing.

### Code defect
None outstanding. Everything found this session is fixed and has a test that
fails without the fix.

### Operational risk

- **RPO for the current outage is ~10 days, not the ~24 hours R-09 assumes.**
  Every backup after 2026-08-22 failed for the same cause as the outage, so the
  newest recoverable point is that morning. The artifact expires around
  2026-09-26; after that there is no recovery point at all.
- **The backup workflow will keep failing** until the database exists, and each
  failure is another day off the recoverable window.
- **`experimental.authInterrupts` is an experimental Next flag.** It has been
  stable since 15.1.0 and only makes `forbidden()` callable, but a future major
  could rename or graduate it. `tests/phase17-forbidden-boundary.test.ts` fails
  if the flag disappears, so the regression cannot be silent.
- **Five lint warnings retained**, all React Compiler findings in client
  components (§6). Each is a real observation about render behaviour, not a
  false positive.
- **No source-map upload.** When a Sentry DSN exists, production stack traces
  will point at minified code until `withSentryConfig` and `SENTRY_AUTH_TOKEN`
  are added.
- **`lib/admin/ownership-transfer.ts` still sends directly** and swallows the
  failure. Mitigated by the in-app notification and the `sessionVersion` bump,
  so a lost email is not a lost nomination.

### External credential

- **Supabase.** No credential exists in this repository, in CI, or in Vercel's
  readable configuration. Blocks every production verification. §2.
- **Sentry DSN.** Blocks levels 3 and 4 of observability verification. §12.
- **GitHub Pro (or an organisation plan).** Blocks branch protection and
  rulesets. §11.

### Human legal decision

- **P15-005 — treatment-history retention.** Unchanged and deliberately so. The
  safest current behaviour is retained: erasure does not touch
  `treatment_history`, and the privacy notice says so. There is no authoritative
  policy in the repository, so no interpretation was invented.
- **`LEGAL_DOCUMENT_STATUS` is still `'draft'`**, enforced by
  `tests/phase15-legal-surface.test.ts`, and `OPERATOR_IDENTITY` is still all
  `null`. The documents render an unmissable "unreviewed" banner and an explicit
  "not yet supplied" block for the controller identity. Nothing here was marked
  approved.

### Future Phase 18 work

Out of scope for this release and not started: consolidating the five hand-rolled
enqueue/drain callers onto `lib/messaging/outbox.ts`; the four NUL bytes in
`prisma/rbac-seed.ts` that hide the authoritative permission seed from `grep`;
and every deferred product area (clinical notes and attachments, payment refunds,
shift close, staff commission, rooms and resources, block-time, integrations,
platform billing UI, payroll and own-tier reports), all still correctly
classified as deferred and none built to satisfy a checker.
