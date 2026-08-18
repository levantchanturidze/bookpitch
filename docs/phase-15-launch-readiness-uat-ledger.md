# Phase 15 — Launch readiness, UAT and pilot operations ledger

**Status: ENGINEERING COMPLETE — EXTERNAL LAUNCH VERIFICATION BLOCKED**

> **Read R-16 first.** Production's `FIELD_ENCRYPTION_KEY` is malformed, so
> signup, patient clinical fields and MFA enrolment all return 500 today. It is
> a one-line configuration fix and it blocks everything else.

Every safely implementable requirement is implemented and proven. The three
remaining blockers are DNS records and a human reading a mailbox; none is an
engineering task, and none can be completed by an agent without authorisation.

Recommendation: **CONDITIONAL GO** — see `docs/pilot-plan-and-go-no-go.md`.

---

## 1. Preflight (Phase 15.0)

| Item | Value |
|---|---|
| Branch | `agent/phase-15-launch-readiness-uat` |
| Baseline SHA | `7d7f7e05780ef914bac49422d4ab1eae4c5aed0f` |
| `origin/main` at start | `7d7f7e05780ef914bac49422d4ab1eae4c5aed0f` |
| Merge-base | identical; 0 ahead, 0 behind |
| Working tree | clean |
| Open PRs / incidents | none |
| CI at baseline | run `32113992124` — success |
| Production health | `/api/health` → `{"ok":true}` |
| Production monitor | run `32172833269` — 18/18 checks passed |
| Production deployment | `dpl_AbFp1ZVHJ7Ep6KtH9WKsfJsvRuD6`, serving `7d7f7e0` |
| Migrations | 62 on disk, `migrate status` up to date, no drift |
| Baseline tests | 77 files / 935 tests, exit 0 |
| Recovery branch | `backup/local-main-before-phase14` @ `517ed0a` — untouched |

`origin/main` did not advance during this phase.

---

## 2. Launch surface inventory (Phase 15.1)

Read from the current code, not from prior reports.

| Surface | Count |
|---|---|
| Pages (`app/**/page.tsx`) | 39 (37 at baseline + `/privacy`, `/terms`) |
| API route handlers | 77 |
| Public path clauses in `isPublicPath` | 26 |
| Scheduled cron endpoints | 5 |
| Prisma migrations | 62 |
| Unit/integration test files | 81 |
| Playwright specs | 3 (× 6 projects) |

### Public surface (no session required)

`/signin`, `/signup`, `/reset`, `/invite`, `/onboard/{pending,success,expired,error}`,
`/book/[slug]`, `/offline`, `/privacy`, `/terms`, `/icon*`, and the APIs
`/api/onboard`, `/api/onboard/verify`, `/api/onboard/resend`,
`/api/invitations/accept`, `/api/public/book`, `/api/auth/*`, `/api/health`,
`/api/health/ops` (bearer-gated).

Everything else redirects to `/signin` via `proxy.ts`. Unknown paths redirect
too rather than 404 — deliberate, so a 404 cannot be used to enumerate routes.

### Roles — 13, across three planes

Read from `prisma/rbac-seed.ts`, not inferred.

- **Platform:** `SUPER_ADMIN` (1000), `PLATFORM_ADMIN` (900),
  `BILLING_MANAGER` (850), `SUPPORT_AGENT` (800)
- **Organisation:** `ORG_OWNER` (100), `ORG_ADMIN` (80), `BRANCH_MANAGER` (60),
  `SENIOR_PROVIDER` (50), `FRONT_DESK` (40), `PROVIDER` (40),
  `ACCOUNTANT` (30), `MARKETING` (30)
- **Consumer:** `CLIENT` (0) — marker only; access resolved by ownership

A legacy `UserRole` enum (`owner`/`practitioner`/`receptionist`) also exists in
`prisma/schema.prisma` and is not the RBAC role set.

### Scheduled workflows

All five run from GitHub Actions (`.github/workflows/cron.yml`), not Vercel Cron.

| Job | Schedule | Status |
|---|---|---|
| reminders | `*/15 * * * *` | Firing reliably |
| housekeeping | `3 * * * *` | Firing reliably |
| retention | `17 2 * * *` | Firing |
| audit-digest | `0 8 * * 1` **+ `3 * * * *`** | Weekly delivery never fired; now also hourly and idempotent (P15-004, P15-009) |
| db-partitions | `30 1 1 * *` | Same exposure as audit-digest |

### External dependencies

Vercel (hosting, `fra1`), Supabase (PostgreSQL, EU), Resend (email),
Cloudflare Turnstile (signup bot protection), Sentry (errors), GitHub Actions
(cron, CI, backups).

---

## 3. Findings

| ID | Sev | Title | Status |
|---|---|---|---|
| P15-001 | P1 | No public legal surface | **Fixed** |
| P15-002 | P1 | Erasure leaves insurance PII; leaks via claims export | **Fixed** |
| P15-003 | P2 | Audit-digest monitor check cannot fail | **Fixed** |
| P15-004 | P2 | Weekly cron never fired | **Fixed** — moved to the hourly schedule |
| P15-005 | — | Treatment history survives erasure | **Deliberately not fixed** — legal decision |
| P15-006 | P2 | Playwright suite never ran in CI | **Fixed** |
| P15-007 | P2 | Load-test workflow could target production | **Fixed** |
| P15-008 | P1 | Test suite had no DB identity guard | **Fixed** |
| P15-009 | P1 | Digest bypassed the outbox; its metric could never be non-null | **Fixed** |
| P15-010 | **P0** | `FIELD_ENCRYPTION_KEY` malformed in production — signup, clinical fields and MFA all 500 | **Detected**; correction is human-only |
| P15-011 | P2 | Monitor incidents opened unassigned, so nobody was ever notified | **Fixed** |
| P15-013 | P2 | Phase 15 reported the sending domain unverified — wrong hostnames queried | **Retracted and corrected** |
| P15-012 | P3 | Concurrent test runs on one database corrupt each other's fixtures | **Root-caused and fixed** |

### P15-001 · No public Privacy Policy, Terms, or consent surface — P1

- **Persona.** Every prospective user; every patient whose data is stored.
- **Reproduction.** `curl -sI https://bookpitch.ge/privacy` → `307 → /signin`.
  Same for `/terms`. No such pages existed; the `proxy.ts` catch-all made them
  indistinguishable from a typo. No consent text on `/signup`.
- **Expected.** A product storing `customers.allergies`,
  `customers.clinical_notes` and `treatment_history` — special-category health
  data — publishes a reachable privacy notice and terms.
- **Root cause.** Never built. The only privacy surface,
  `/settings/privacy`, is authenticated GDPR *tooling*, not a notice.
- **Fix.** `app/(legal)/privacy/page.tsx`, `app/(legal)/terms/page.tsx`,
  `components/legal/LegalPage.tsx`, `components/legal/LegalFooter.tsx`,
  `lib/legal.ts`; both paths added to `isPublicPath` in `auth.config.ts`;
  footer links on `/signup` (with point-of-collection consent wording) and
  `/signin`. Text is grounded in the implementation and states no compliance
  claim; operator identity is deliberately `null` rather than invented; an
  unmissable draft banner renders while `LEGAL_DOCUMENT_STATUS === 'draft'`.
- **Proof.** `tests/phase15-legal-surface.test.ts` (18 tests) —
  including *“still gates the application surfaces it was already gating”*,
  which is the complement showing the allow-list widening opened nothing else.
  Runtime: `/privacy` and `/terms` return **200** with no session while
  `/patients`, `/scheduler`, `/settings/privacy` still **307 → /signin**.
  Browser: `@a11y privacy notice…` and `@a11y terms of service…` across all
  six Playwright projects, plus
  *“the legal documents render for a signed-out visitor”*.
- **Residual.** The text is a draft. `docs/legal-review-checklist.md` gates it.

### P15-002 · Erasure leaves insurance PII, which leaks via claims export — P1

- **Persona.** Any patient exercising erasure; any organisation relying on the
  retention sweep.
- **Reproduction.** Create an insured customer with a completed, ICD-coded
  appointment; call `anonymizeCustomer(...)`; run `buildClaimsExport(...)`. The
  “erased” patient is still listed, by real name and policy number.
- **Root cause.** The redaction field set was duplicated between
  `anonymizeCustomer()` and `runRetentionTick()`. Both cleared name, email,
  phone, dob, gender, avatar, allergies and clinical notes; neither cleared
  `insurerName` or `insurancePolicyNumber`. `buildClaimsExport()` selects on
  `insurancePolicyNumber: { not: null }`, so the leftover field put the patient
  back into the export. Existing tests asserted only the fields that worked.
- **Fix.** One exported `CUSTOMER_REDACTION_FIELDS` constant in `lib/gdpr.ts`,
  spread by both paths, so they cannot drift again.
- **Proof.** `tests/phase15-erasure-completeness.test.ts` (5 tests). Asserts
  the *observable* outcome — disappearance from the claims export — not just
  that the columns are null. **Complement verified:** reverting the two fields
  fails 4 of the 5.
- **Residual.** Rows redacted before this deploys keep their insurance fields.
  Production holds no real customer data yet; confirm before assuming.

### P15-003 · The audit-digest monitor check could never fail — P2

- **Reproduction.** `evaluateOpsMetrics` with
  `auditDigest: { hoursSinceLastQueued: null }` → `ok: true`, unconditionally.
- **Root cause.** `null` was read as “young deployment, nothing due yet”, which
  is true only while nothing is due. A weekly job that never ran once reported
  PASS forever — exactly the CLAUDE.md pattern of a control that changes no
  observable behaviour. Production has been reporting
  *“no audit digest mail has ever been queued (expected on a new deployment)”*
  as a **pass** while the job had in fact never executed.
- **Fix.** New `oldestEligibleOrgAgeHours` metric in `lib/ops-metrics.ts` (age
  of the oldest org with an emailable owner, mirroring `sendDigestToOwners`),
  and `evaluateAuditDigest()` in `scripts/production-monitor.mjs` which fails
  when a digest has been due longer than the window and none was ever queued.
- **Proof.** `tests/production-monitor.test.ts` — four cases pinning both
  inputs, including *“FAILS a digest that has never run once an eligible org
  outlives the window”*. `tests/ops-metrics.test.ts` asserts the new metric
  shape against a real database, so the SQL is executed, not mocked.

### P15-004 · The weekly cron has never fired — P2 — **fixed**

- **Evidence.** On Monday 2026-08-17, runs at 07:52, 08:06 and 08:41 carry the
  `*/15` and hourly schedules with `audit-digest=skipped`. No run carries
  `0 8 * * 1`. GitHub dropped the weekly schedule.
- **Confirmed in production.** After deploying the P15-003 check, the monitor
  reported: *“no audit digest has EVER been queued, but an eligible
  organization has existed for 477.8h (limit 240h)”*. Twenty days, zero
  digests. The old check had been reporting PASS throughout.
- **Fix.** The job now also runs on the reliable hourly schedule
  (`3 * * * *`) in `.github/workflows/cron.yml`. That is only safe because
  P15-009 made `runDigestForAllOrgs()` idempotent per ISO week, enforced by a
  unique index rather than by trusting the caller's timing. The weekly entry is
  kept so it still fires promptly on Monday when GitHub does deliver it.
- **Proof.** `tests/phase15-digest-delivery.test.ts` —
  *“is idempotent within an ISO week — a second run queues nothing”*, plus four
  `isoWeekKey` cases covering week boundaries and the year rollover.

### P15-009 · The digest bypassed the outbox, so its metric could never move — P1

- **Found while deploying the P15-003 fix**, which is the only reason it
  surfaced: the new check went red in production and could not have gone green.
- **Root cause, two halves.** `sendDigestToOwners()` called
  `getEmailProvider().send()` directly. (a) A provider failure was caught,
  logged at warn, and discarded — the digest was lost, with none of the claim
  locking, backoff, dead-lettering or encryption that every other transactional
  message gets. (b) `lib/ops-metrics.ts` measures freshness with
  `max(created_at) FROM email_outbox WHERE purpose = 'audit_digest'`, and
  **nothing in the codebase ever wrote that purpose**. `hoursSinceLastQueued`
  was structurally pinned at `null`.
- **Why this matters beyond the digest.** It made the P15-003 fix a permanent
  red rather than a working control. A monitor that can only fail is not much
  better than one that can only pass.
- **Fix.** The digest is enqueued to `email_outbox` with
  `purpose: 'audit_digest'`, an encrypted recipient and body, and an
  idempotency key of `audit_digest:{orgId}:{addressHash}:{isoWeek}` against the
  existing sparse unique index. No migration required.
- **Proof.** `tests/phase15-digest-delivery.test.ts` (8 tests). The decisive
  one is *“moves the ops metric off null — the signal the monitor reads”*:
  `collectOpsMetrics()` returns a real number as a consequence of running the
  digest, which was impossible before.
- **Recorded as** R-08 in `docs/phase-15-risk-register.md`.

### P15-005 · Treatment history survives erasure — undecided, not a defect call

- Neither erasure path touches `treatment_history`; those rows hold health data
  and outlive a redaction request.
- **Deliberately not changed.** It is plausibly correct: clinical records may
  carry a statutory retention duty that outlives an erasure request. Deleting
  them on a guess destroys records; hiding the behaviour misleads. CLAUDE.md
  says to stop and ask where the spec is ambiguous, so the behaviour is
  disclosed on `/privacy` and raised in `docs/legal-review-checklist.md`.

### P15-006 · The browser and accessibility suite never ran in CI — P2

- **Reproduction.** `.github/workflows/ci.yml` had two jobs and ended at
  `npm run build`; no workflow referenced Playwright.
- **Impact.** 141 checks across three engines and three viewports — the entire
  output of Phase 14 — gated nothing.
- **Fix.** An `e2e` job running the `@a11y` and `@responsive` tags across all
  six projects, with a Postgres service, migrations, seed and report upload.
- **Residual.** `e2e/signup-scheduler.spec.ts` is excluded: under `next start`,
  `NODE_ENV=production` makes `SignupForm` fail closed without a Turnstile site
  key. **It was not disabled or weakened** — that fail-closed behaviour is a
  control worth keeping. Running it needs Cloudflare's public always-pass test
  keys. This spec also fails at the *baseline* commit for the same reason,
  verified by stashing.

### P15-007 · The load-test workflow could be pointed at production — P2

- **Reproduction.** `.github/workflows/load-test.yml` gated only on
  `STAGING_URL` being non-empty. Setting that secret to the production URL
  would have run weekly k6 load against the live service.
- **Fix.** A guard step that derives the host from the secret (never echoing
  it) and refuses `bookpitch.ge`, `vercel.app` and `supabase.co`, before k6 is
  installed. Plus `scripts/perf-baseline.mjs`, which fails closed on any
  non-loopback host and refuses production **even with the override set**.
  `vercel.app` is included because Preview inherits production env vars.
- **Proof.** `tests/phase15-perf-guard.test.ts` (11 tests), including
  *“refuses production even when the override is set”* and *“fails closed on an
  unrecognised remote host”*. Found and fixed a real bug in the guard while
  testing: `URL.hostname` returns `[::1]` with brackets, so IPv6 loopback was
  being refused.

### P15-008 · The test suite had no database identity guard — P1

- **Reproduction.** `tests/setup.ts` loaded `.env.local` and connected. No
  check on where. The suite creates organisations, users, customers and
  appointments and calls `deleteMany` in cleanup.
- **Root cause.** `prisma/_require-local-db-guard.ts` guards the *seed scripts*
  and evaluates *before* `.env.local` loads, so it never sees the URL the tests
  actually use. The repository was safe only because `.env.local` happens to
  point at localhost.
- **Fix.** `assertDisposableDatabase()` in `tests/setup.ts`, running before any
  test. Allow-list of loopback plus the CI `postgres` service host; production
  markers as a second line; **fails closed** on an unrecognised host and when
  no URL is set at all. Checks all six DB URL variables, and never puts a
  credential in the message.
- **Proof.** `tests/phase15-db-guard.test.ts` (10 tests), including
  *“fails closed on an unrecognised host rather than allowing it”*,
  *“refuses when no database URL is set at all”*, and
  *“never puts a credential in the failure message”*.

---

### P15-010 · The production encryption key is malformed — P0

- **Evidence.** Vercel runtime log, `dpl_AnCxShtJ4zagx87dYhJiG1ZFANUE`,
  `POST /api/cron/audit-digest` → 500:
  `Error: FIELD_ENCRYPTION_KEY must be "<key-id>:<64-hex-chars>"`. Thrown from
  `parseKeySpec()` on the `colon < 1` branch, so the variable is set and simply
  lacks its `<key-id>:` prefix.
- **Impact.** Every `encryptField()` call throws: self-service signup
  (`lib/onboarding.ts`), patient allergies and clinical notes
  (`lib/customers.ts`), MFA enrolment (`lib/platform/mfa.ts:89`), the
  security alert mails, and the audit digest. Production cannot onboard a
  single organisation today.
- **Why nothing caught it.** No signup, no customer and no MFA enrolment had
  ever happened in production, so the encryption layer had never been asked to
  do anything. `REQUIRED_SECURITY_ENV` checked that the variable was *present*,
  and it is. The monitor had been reporting `security=0` — configuration
  complete — the whole time.
- **How it surfaced.** Deploying P15-003 and then P15-009 made the digest the
  first production code path to call `encryptField()`. Neither change caused
  the defect. This is the phase's clearest illustration of its own premise:
  a green suite and a green monitor proved nothing about a path that had never
  run.
- **Fixed here: detection.** `SECURITY_ENV_VALIDATORS` / `invalidEnv()` in
  `lib/ops-metrics.ts` validate format, and `production-config-invalid` in
  `scripts/production-monitor.mjs` fails on it.
- **Not fixed here: the value.** Correcting a production secret is a human
  action and explicitly outside what may be done autonomously. No attempt was
  made to read, write or rotate it.
- **Proof.** `tests/phase15-config-validity.test.ts` (13 tests). The first uses
  the exact shape of the real production value — a bare 64-hex string — and
  asserts it is reported invalid. One test cross-checks the validator against
  the parser it stands in for, so the two cannot drift and start lying about
  production.

### P15-012 · Concurrent test runs corrupt each other — P3 — **root-caused and fixed**

- **Symptom.** `tests/platform-break-glass.test.ts > Phase 11 Row 9: reauth
  grants are invalidated on TOTP path` failed with `expected 400 to be 200`,
  roughly one full run in five. Passed with the file alone (0/10 failures),
  passed at the baseline commit, and never failed in CI.
- **Root cause.** Two vitest processes running against the same local database
  at once. The suite shares one database and runs files serially for exactly
  that reason (`fileParallelism: false`), but nothing prevented a *second*
  process. When two runs overlap, one run's `beforeEach` resets
  `mfa_last_totp_window` and the rate-limit buckets for the shared seeded
  super-admin while the other run is mid-request — and that request gets a 400
  from a control doing precisely its job.
- **It was self-inflicted.** A background run of the break-glass file
  (task `b5g292eww`) was still executing when a full `npm test` was started.
  CI never saw it because CI runs exactly one process. `vitest.config.ts`
  already carried a warning about "two concurrent test processes sharing a
  connection pool" from an earlier incident.
- **Two wrong theories were tried and discarded**, both recorded because the
  discarding is the evidence: (a) TOTP replay — ruled out, `beforeEach` already
  resets `mfaLastTotpWindow` to `null`; (b) a TOTP step-boundary race — ruled
  out by measurement, the verifier tolerates ±1 step
  (probe: previous-, current- and next-step codes all accepted).
- **Fix.** `tests/global-setup.ts` takes a run-scoped PostgreSQL advisory lock
  (key `7698234762`, distinct from `HOUSEKEEPING_LOCK_KEY`). A second
  concurrent run now fails immediately with an explanation instead of producing
  a misleading red.
- **Why globalSetup and not setupFiles.** Measured, not assumed: vitest forks a
  process per test file, so a session lock taken in `setupFiles` is released
  when each file's process exits, leaving gaps a second run slips through. A
  first attempt at that level was built and observed to fail to refuse a
  concurrent run.
- **Proof.** `tests/phase15-suite-lock.test.ts` (5 tests), the decisive one
  asserting the lock is *actually held right now from a different database
  session* — a content check of the setup file would pass even if the lock were
  never taken. Plus a live demonstration with timestamps: run A 22:04:43→22:06:05,
  run B started 22:04:51 and exited **1** with
  `[suite lock] another test run already holds this database`, while A completed
  cleanly.
- **Also improved.** The assertion that failed now prints the response body, so
  a future failure here names its cause instead of saying only
  "expected 400 to be 200".

### P15-013 · Phase 15 reported the sending domain unverified — that was wrong

- **The error.** An earlier Phase 15 revision reported no SPF, no DKIM and no
  bounce MX for the sending domain, and made it the top launch blocker across
  the risk register, go/no-go matrix and launch checklist.
- **Reality** (`dig @8.8.8.8`, 2026-08-18T22:07:24Z):
  `resend._domainkey.send.bookpitch.ge` holds an RSA DKIM key;
  `send.send.bookpitch.ge` publishes `v=spf1 include:amazonses.com ~all` and
  MX `10 feedback-smtp.eu-west-1.amazonses.com`. The sending domain
  `send.bookpitch.ge` is verified, exactly as Phase 13 recorded.
- **Root cause.** The sending domain was inferred from an illustrative example
  in a comment in `lib/messaging/email/resend.ts`
  (`e.g. "Bookpitch <no-reply@bookpitch.ge>"`) and the apex was queried as if it
  were the configured value. `RESEND_FROM` is a Vercel variable that cannot be
  read back, so the true domain had to come from Phase 13's ledger — and was
  not taken from it.
- **Corrected in.** `docs/email-dns-readiness.md` (rewritten, with the
  reconciliation table), `docs/phase-15-risk-register.md` (R-01 retracted, R-02
  and R-03 downgraded to hardening), `docs/pilot-plan-and-go-no-go.md`,
  `docs/launch-checklist.md`.
- **Net effect on launch.** Two claimed email blockers disappear. One remains
  and is genuine: no message has ever been received in a real mailbox and no
  `Authentication-Results` header has been inspected (R-04).

## 4. Requirement reconciliation

| Phase | Requirement | Status | Evidence |
|---|---|---|---|
| 15.0 | Preflight and ledger | **IMPLEMENTED AND PROVEN** | §1; this file |
| 15.1 | Launch surface + journey inventory | **IMPLEMENTED AND PROVEN** | §2; §5 |
| 15.2 | Safe UAT env + synthetic-data controls | **IMPLEMENTED AND PROVEN** | P15-008; `E2E-PHASE15-` prefixes; §6 |
| 15.3A | Signup and activation | **PARTIALLY IMPLEMENTED** | 4 suites green locally; production submission is human-only (R-05) |
| 15.3B | Authentication and account security | **IMPLEMENTED AND PROVEN** | `credentials`, `platform-mfa`, `platform-password-reauth`, `password-reset`, `route-access`, `org-switch-residue` |
| 15.3C | Organisation onboarding | **IMPLEMENTED AND PROVEN** | `onboarding`, `org-toggles`, `admin`, `available-slots` |
| 15.3D | Staff and role administration | **IMPLEMENTED AND PROVEN** | `rbac-*`, `branch-scoping`, `phase12-owner-invariant`, `org-transfer`, `platform-support-agent` |
| 15.3E | Customer/patient workflow | **IMPLEMENTED AND PROVEN** | `customers-api`, `gdpr`, `rls`, `phase15-erasure-completeness` |
| 15.3F | Scheduling lifecycle | **IMPLEMENTED AND PROVEN** | `appointments-api`, `available-slots`, `public-booking`, `waitlist` |
| 15.3G | Notifications and outbox | **IMPLEMENTED AND PROVEN** | `outbox-durable`, `notifications`, `messaging-providers`, `housekeeping` |
| 15.3H | Reports, dashboards, exports | **IMPLEMENTED AND PROVEN** | `analytics`, `insurance`, `audit-query`, `platform-audit`, `ops-metrics` |
| 15.4 | Human production UAT checklist | **IMPLEMENTED AND PROVEN** (document) / **EXTERNAL VERIFICATION BLOCKED** (execution) | `docs/production-uat-checklist.md` |
| 15.5 | Email deliverability and DNS | **EXTERNAL VERIFICATION BLOCKED** | `docs/email-dns-readiness.md`; DNS captured 2026-08-18 |
| 15.6 | Privacy and legal surface | **PARTIALLY IMPLEMENTED** | P15-001 shipped; review is external |
| 15.7 | Support and operational readiness | **IMPLEMENTED AND PROVEN** | `docs/support-runbook.md`, `docs/pilot-onboarding-runbook.md`, `docs/launch-checklist.md` |
| 15.8 | Performance and capacity baseline | **IMPLEMENTED AND PROVEN** | `docs/performance-baseline.md`; `scripts/perf-baseline.mjs`; P15-007 |
| 15.9 | Reliability and external-risk reconciliation | **IMPLEMENTED AND PROVEN** | `docs/phase-15-risk-register.md` — 14 risks; Dependabot root-caused |
| 15.10 | Pilot plan and go/no-go | **IMPLEMENTED AND PROVEN** | `docs/pilot-plan-and-go-no-go.md` |
| 15.11 | Finding management | **IMPLEMENTED AND PROVEN** | §3 — 8 findings; all safely fixable ones fixed |
| 15.12 | Verification matrix | **IMPLEMENTED AND PROVEN** | §7 |
| 15.13 | Documentation package | **IMPLEMENTED AND PROVEN** | §8 |
| 15.14 | Git, PR, CI, merge, deploy | **IMPLEMENTED AND PROVEN** | PR and deployment recorded in the final report |

### Not claimed

- **Load/capacity at scale.** The baseline is a laptop and a five-request
  production smoke probe. `docs/performance-baseline.md` says so explicitly.
- **Authenticated performance paths.** Not measured; would need a seeded
  disposable database.
- **DMARC readiness.** No message has been sent, received or inspected.
- **Legal or regulatory compliance.** Automated checks cannot establish it.
- **Accessibility compliance.** Axe and the contrast gate pass on reachable
  surfaces; that is not a WCAG conformance claim.

---

## 5. Critical journey matrix

Cleanup for every automated row is the suite's own `afterAll`, scoped to
fixture ids. Synthetic records use the `E2E-PHASE15-` prefix.

| # | Journey | Role | Class | Automated proof | Human-only part |
|---|---|---|---|---|---|
| 1 | Signup → pending | anonymous | launch critical | `onboard-*` (4 suites) | Real Turnstile + production submit |
| 2 | Verification email delivered | anonymous | launch critical | Intent durability: `outbox-durable` | **Real mailbox — blocked** |
| 3 | Activation idempotent/concurrent | anonymous | launch critical | `onboard-activation` | — |
| 4 | Sign in / fail closed | all | launch critical | `credentials`, `route-access` | — |
| 5 | MFA enrol, TOTP, recovery codes | platform | launch critical | `platform-mfa` | Authenticator app |
| 6 | Reauthentication + break-glass | `SUPER_ADMIN` | pilot critical | `platform-password-reauth`, `platform-break-glass` | — |
| 7 | Org configuration affects behaviour | `ORG_OWNER` | launch critical | `org-toggles`, `available-slots` | — |
| 8 | Role permissions allow **and** deny | all 13 | launch critical | `rbac-can`, `rbac-rank`, `route-access` | — |
| 9 | Last-owner invariant | `ORG_OWNER` | launch critical | `phase12-owner-invariant` | — |
| 10 | Cross-tenant denial | all | launch critical | `rls`, `rbac-rls`, `db-role-grants` | — |
| 11 | Customer CRUD + isolation | `FRONT_DESK`+ | launch critical | `customers-api` | — |
| 12 | Erasure completeness | `ORG_OWNER` | launch critical | `phase15-erasure-completeness` | — |
| 13 | Appointment lifecycle + conflicts | `FRONT_DESK`+ | launch critical | `appointments-api`, `available-slots` | — |
| 14 | Public booking | `CLIENT` | pilot critical | `public-booking` | — |
| 15 | Reminders delivered | system | launch critical | `reminders`, `outbox-durable` | **Real mailbox — blocked** |
| 16 | Outbox retry / dead-letter / stale claim | system | operational | `outbox-durable`, `housekeeping` | — |
| 17 | Retention sweep | system | operational | `gdpr`, `phase15-erasure-completeness` | — |
| 18 | Weekly audit digest | system | operational | `audit-digest` | **Schedule never fires — P15-004** |
| 19 | Analytics / insurance export | `ACCOUNTANT` | pilot critical | `analytics`, `insurance` | — |
| 20 | Platform org administration | `PLATFORM_ADMIN` | operational | `platform-orgs`, `platform-audit` | — |
| 21 | Legal surface reachable | anonymous | launch critical | `phase15-legal-surface` + 6 Playwright projects | Legal review |
| 22 | Health endpoint leaks nothing | anonymous | launch critical | `production-monitor`, `ops-metrics` | — |

---

## 6. UAT environment and synthetic-data controls (15.2)

| Requirement | How it is met |
|---|---|
| Writes only to isolated DB | Local `bookpitch_dev` on loopback; CI uses an ephemeral `postgres` service container |
| Unmistakable synthetic marker | `E2E-PHASE15-` on all Phase 15 fixtures |
| Deterministic setup/cleanup | `beforeAll`/`afterAll`, cleanup by captured fixture id |
| No wildcard deletion | Cleanup deletes by explicit id only |
| Cleanup is not the isolation mechanism | RLS + org filtering are; cleanup is hygiene (`rls`, `rbac-rls`, `db-role-grants`) |
| Audit evidence preserved | `audit_log` is append-only; `tests/helpers/audit-reset.ts` is a dev-only escape hatch |
| Artifacts not committed | `test-results/`, `playwright-report/` ignored; verified before commit |
| Cannot resolve to production | **P15-008** — `assertDisposableDatabase()` in `tests/setup.ts` |
| Fails closed on unknown identity | Allow-list; unrecognised host and missing URL both refuse |

---

## 7. Verification matrix (15.12)

All commands run at the final Phase 15 tree.

| Gate | Command | Result | Exit |
|---|---|---|---|
| Whitespace | `git diff --check` | clean | 0 |
| Prisma validate | `npx prisma validate` | valid | 0 |
| Prisma generate | `npx prisma generate` | ok | 0 |
| Migration status | `npx prisma migrate status` | 62 applied, up to date | 0 |
| TypeScript | `npx tsc --noEmit` | clean | 0 |
| ESLint | `npm run lint` | clean | 0 |
| Format | `npm run format:check` | clean | 0 |
| Unit + integration | `npm test` | **83 files / 1007 tests passed** | 0 |
| Guards | `npm run test:guards` | ok | 0 |
| Orphan permissions | `npm run check:orphan-perms` | 19 marked, 0 unmarked | 0 |
| Playwright, all 6 projects | `npx playwright test --grep "@a11y\|@responsive"` | **177 passed, 3 skipped** | 0 |
| UI analyser / contrast | `tests/ui-surface-analysis.test.ts` | 30 passed, 0 AA failures reachable | 0 |
| Performance | `node scripts/perf-baseline.mjs` | 0% error, see baseline | 0 |
| Perf production guard | `BASE_URL=https://bookpitch.ge …` | **refused**, as designed | 2 |
| Production build | `npm run build` | 40 static pages | 0 |
| Dependency audit | `npm audit --audit-level=high` | 0 vulnerabilities | 0 |
| Secret scan | `gitleaks detect` (229 commits) | no leaks | 0 |

Test count: **935 → 1007** (+72). Playwright: **141 → 177** (+36).

Also verified:

- No `.only`, no newly skipped test. The 3 Playwright skips are pre-existing
  project/viewport exclusions, not quarantines.
- **Execution-order independence: claimed, with evidence.** P15-012 was
  root-caused to concurrent test processes sharing one database, not to an
  order dependency within a run. A run-scoped advisory lock now makes that
  state unreachable, and consecutive sequential full-suite runs pass — see §7.
- No snapshot updated.
- No Playwright artifact committed.
- No production identifier or customer data in any fixture.
- No environment guard bypassed — two were **added** (P15-007, P15-008).
- No security or accessibility rule broadly suppressed. The gitleaks allowlist
  is one literal, probe-verified to still catch a real `sk_live_…` key in
  `tests/`; an earlier draft that paired `regexes` with `paths` silently
  allowlisted every secret in every test file and was caught and replaced.
- `scripts/analyze-ui.mjs` gained `amber-900` so the new draft banner is
  *covered* by the contrast gate (8.75:1) rather than skipped as unknown.

---

## 8. Documentation package (15.13)

| Document | Purpose |
|---|---|
| `docs/phase-15-launch-readiness-uat-ledger.md` | This file |
| `docs/production-uat-checklist.md` | Human production validation |
| `docs/email-dns-readiness.md` | DNS state, exact records, rollout |
| `docs/legal-review-checklist.md` | Gate on publishing legal text |
| `docs/support-runbook.md` | Incident intake, severity, diagnosis, rollback |
| `docs/pilot-onboarding-runbook.md` | Bringing one organisation on |
| `docs/pilot-plan-and-go-no-go.md` | Caps, stop criteria, go/no-go matrix |
| `docs/phase-15-risk-register.md` | 14 risks with evidence |
| `docs/performance-baseline.md` | Measurements and pilot envelope |
| `docs/launch-checklist.md` | The single ordered list |

---

## 9. Remaining external blockers

0. **Correct `FIELD_ENCRYPTION_KEY` in production** (R-16) — set it to
   `<key-id>:<64-hex-chars>`, e.g. prefix the existing 64 hex characters with
   `k1:`. **This blocks everything else**, including the email UAT, because
   signup fails before any mail is queued.
1. **Verify `bookpitch.ge` in Resend and publish DKIM/SPF/MX** (R-01).
2. **Publish `_dmarc.bookpitch.ge`** at `p=none` with a reachable `rua`
   (R-02, R-03).
3. **Designate a test mailbox and run `docs/production-uat-checklist.md`
   §A–B**, confirming `spf=pass`, `dkim=pass`, `dmarc=pass` (R-04, R-05).
4. **Legal review** — `docs/legal-review-checklist.md`, including the P15-005
   decision.
5. **Enable Dependabot alerts** — free, two clicks (R-06).

Item 0 is the priority. Items 1–3 are the remaining launch blockers and are one piece of work.
