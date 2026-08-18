# Phase 15 risk register

Every row states current evidence, not an assumption. "Owner accepts" is left
unticked everywhere: that is the repository owner's decision to record, and no
agent can make it on their behalf.

Severity of the launch/pilot columns:
**Blocker** = do not proceed. **Conditional** = proceed only with the stated
mitigation in place. **Accepted risk** = proceed, informed.

---

## R-01 · Sending domain email authentication — **RETRACTED, was reported in error**

- **Earlier claim (wrong).** An earlier Phase 15 revision reported no SPF, no
  DKIM and no bounce MX, and made this a launch blocker.
- **Actual evidence** (`dig @8.8.8.8`, 2026-08-18T22:07:24Z):
  `resend._domainkey.send.bookpitch.ge` holds an RSA DKIM key;
  `send.send.bookpitch.ge` publishes `v=spf1 include:amazonses.com ~all` and
  MX `10 feedback-smtp.eu-west-1.amazonses.com`. The sending domain
  `send.bookpitch.ge` **is** verified, exactly as Phase 13 recorded.
- **Why the error happened.** The sending domain was inferred from an
  illustrative example in a comment in `lib/messaging/email/resend.ts`
  (`e.g. "Bookpitch <no-reply@bookpitch.ge>"`) and the apex was queried as if it
  were the configured value. `RESEND_FROM` cannot be read back from Vercel, so
  the configured domain had to come from Phase 13's ledger — and was not taken
  from it.
- **Status.** **No action required. Not a blocker.** Full reconciliation in
  `docs/email-dns-readiness.md` §2.

## R-02 · No organisational DMARC record

- **Evidence.** `_dmarc.bookpitch.ge` absent; a subdomain record exists at
  `_dmarc.send.bookpitch.ge` with `p=none`.
- **Probability.** Certain.
- **Impact.** No policy at the organisational domain, so receivers have no
  instruction for unauthenticated mail claiming to be from it, and the domain
  is more attractive to spoof. Reduces inbox placement.
- **Mitigation.** Publish `_dmarc` at `p=none` with a reachable `rua`, monitor
  a full reporting cycle, then tighten.
- **Residual.** Spoofing remains possible while at `p=none` — that is inherent
  to the monitoring phase and is why it must not be left there permanently.
- **Launch: no — hardening. Pilot: no. Money: no.** (Downgraded from
  "Blocker": with DKIM/SPF present and a subdomain policy published, mail from
  `send.bookpitch.ge` is already covered by a DMARC policy. The missing apex
  record costs spoofing resistance and central control, not deliverability.)

## R-03 · DMARC reporting address cannot receive mail

- **Evidence.** Published `rua=mailto:dmarc@bookpitch.ge`; `bookpitch.ge` has
  no MX record.
- **Probability.** Certain.
- **Impact.** Aggregate reports bounce. The monitoring that `p=none` exists to
  provide yields nothing, so nobody learns whether alignment is working.
- **Mitigation.** Point `rua` at a mailbox that exists — see the three options
  in `docs/email-dns-readiness.md` §3b.
- **Residual.** Low.
- **Launch: Conditional (hardening). Pilot: Accepted. Money: no.**

## R-04 · Email delivery has never been exercised in production

- **Evidence.** Production monitor run 32172833269: outbox `pending=0`,
  `dead=0`, "no audit digest mail has ever been queued". No test mailbox has
  been designated.
- **Probability.** Certain.
- **Impact.** The entire notification path — verification, reminders, digests —
  is unproven end to end against a real inbox, however green the unit tests are.
- **Mitigation.** `docs/production-uat-checklist.md` §A–B, after R-01.
- **Residual.** None once a real message is received and its
  `Authentication-Results` inspected.
- **Launch: Blocker. Pilot: Blocker. Money: no.**
- **External action.** Requires a designated test mailbox and a human.

## R-05 · Production signup cannot be completed by automation

- **Evidence.** Signup is gated by a real Cloudflare Turnstile challenge and
  requires entering a password into production.
- **Probability.** Certain, and by design.
- **Impact.** The single most important journey cannot be proven by CI.
- **Mitigation.** The human checklist. Note this is a *property of a working
  control*, not a defect — an automatable CAPTCHA would be a broken CAPTCHA.
- **Residual.** Permanent and acceptable.
- **Launch: Conditional. Pilot: Conditional. Money: no.**

## R-06 · Dependabot alerts are disabled

- **Evidence.** `GET /repos/:owner/:repo/dependabot/alerts` returns
  `403 "Dependabot alerts are disabled for this repository."`;
  `GET /repos/:owner/:repo/vulnerability-alerts` returns `404`;
  `security_and_analysis` is `null`. Repository is private, owner plan `User`.
- **Root cause — investigated, and it is none of the suspected causes.** Not a
  token scope problem (the 403 body names the feature state, not permissions),
  not a plan limitation (Dependabot alerts are free on private repositories),
  and not a repository-visibility issue. The feature is simply switched off.
- **Impact.** No automatic notification of a newly disclosed vulnerability in a
  dependency.
- **Partial mitigation already in place.** `npm audit --audit-level=high` runs
  on every CI run and currently reports **0 vulnerabilities**, so the tree is
  not unmonitored — it is only unmonitored *between* pushes.
- **Mitigation.** Settings → Code security → enable Dependabot alerts. Free,
  two clicks. Not done here: the available token lacks `admin:repo_hook`, and
  changing repository security settings is the owner's call.
- **Residual.** Low once enabled.
- **Launch: Conditional. Pilot: Accepted. Money: no.**

## R-07 · No branch protection

- **Evidence.** Branch protection is unavailable for private repositories on
  the current plan.
- **Impact.** Nothing mechanically prevents a merge with red or missing checks.
- **Mitigation.** Every merge manually verifies each required check against the
  exact head SHA immediately before merging, as recorded in the PR.
- **Residual.** Depends entirely on operator discipline; a mistake is possible.
- **Launch: Accepted. Pilot: Accepted. Money: yes, to remove (paid plan or a
  public repository — neither is authorised).**

## R-08 · Low-frequency scheduled workflows are dropped by GitHub

- **Evidence.** The `0 8 * * 1` schedule in `.github/workflows/cron.yml` did
  **not** fire on Monday 2026-08-17. Runs at 07:52, 08:06 and 08:41 that day
  carry the `*/15` and hourly schedules with `audit-digest=skipped`; no run
  carries the weekly schedule. The weekly audit digest has therefore never
  executed. Same exposure applies to the monthly `30 1 1 * *` partition job.
- **Probability.** High — GitHub explicitly does not guarantee scheduled
  delivery, and drops are most likely on low-frequency crons.
- **Impact.** Owners silently stop receiving audit digests; partition
  maintenance could silently lapse.
- **Confirmed in production.** After the P15-003 check deployed, the monitor
  reported *“no audit digest has EVER been queued, but an eligible organization
  has existed for 477.8h (limit 240h)”* — twenty days, zero digests, while the
  old check reported PASS throughout.
- **Mitigation applied this phase — detection and cure.** P15-003 made the
  failure visible. P15-009 then made `runDigestForAllOrgs()` idempotent per ISO
  week (unique index on `email_outbox.idempotency_key`), which made it safe to
  put the job on the reliable hourly schedule as well as the weekly one.
- **Residual.** Low. The weekly schedule can still be dropped, but the hourly
  one carries the job, and duplicate invocations are database-enforced no-ops.
  The monthly `30 1 1 * *` partition job retains the original exposure — it has
  not been made idempotent and still relies on a low-frequency schedule.
- **Launch: Accepted. Pilot: Accepted. Money: no.**

## R-09 · No point-in-time recovery; ~24h backup RPO

- **Evidence.** Supabase Free. Monitor run 32172833269: last successful backup
  16.1h before the check, limit 26h.
- **Impact.** A destructive event could lose up to roughly a day of changes.
- **Mitigation.** Daily backups plus a restore drill (last success 47h before
  the check, well inside its 960h limit) — so restores are proven to work, only
  the recovery point is coarse. Disclosed to pilot users in `/terms`.
- **Residual.** Real and unavoidable on this plan.
- **Launch: Accepted (disclosed). Pilot: Accepted. Money: yes, to improve.**

## R-10 · Backup ciphertext residency not guaranteed EU-only

- **Evidence.** Backups are age-encrypted (`ops/backup-age-recipient.txt`) and
  stored via GitHub Actions artifacts/storage, whose region is not contractually
  EU-pinned. `ARCHITECTURE.md` §2 claims EU backups; that claim is not
  substantiated.
- **Impact.** A data-residency commitment could not be honoured. Contents are
  encrypted, so this is a residency and contractual exposure, not a
  confidentiality breach.
- **Mitigation.** The privacy notice deliberately does **not** promise EU-only
  backups and states the gap explicitly.
- **Residual.** Open. Needs a legal decision on whether residency must be
  guaranteed, and reconciliation with `ARCHITECTURE.md`.
- **Launch: Conditional (legal). Pilot: Accepted. Money: possibly.**

## R-11 · Single operator, no second responder

- **Evidence.** One maintainer; no on-call rota; incident notification is
  GitHub issue assignment to the repository owner.
- **Impact.** An incident beginning while the operator is unavailable runs
  unattended. Also a bus factor of one for every credential and procedure.
- **Mitigation.** Runbooks are written down (`docs/support-runbook.md`) so a
  second person *could* act; automated monitoring every 30 minutes narrows
  detection time, and P15-011 made those alerts actually reach the operator's
  inbox rather than sitting silently in the issue list. No second responder is
  invented here, because there isn't one.
- **Residual.** High and structural. Genuinely limits the safe size of a pilot,
  which is why the pilot plan caps organisations rather than assuming capacity.
- **Launch: Accepted. Pilot: Accepted, with the cap. Money: yes, to remove.**

## R-12 · Erasure completeness was wrong until this phase

- **Evidence.** P15-002. Both erasure paths left `insurerName` and
  `insurancePolicyNumber` populated, and `buildClaimsExport()` selects on
  `insurancePolicyNumber: { not: null }`, so redacted patients kept appearing in
  insurance claim exports by name and policy number.
- **Status.** **Fixed and proven.** One shared `CUSTOMER_REDACTION_FIELDS`
  constant, with `tests/phase15-erasure-completeness.test.ts` asserting the
  export no longer lists the patient. Four of its five tests fail if the fix is
  reverted — verified.
- **Residual.** Any record redacted in production *before* this deploys still
  holds its insurance fields. Production has no real customer data yet, so the
  practical exposure is nil — but confirm that before assuming it.
- **Launch: resolved. Pilot: resolved.**

## R-13 · Treatment history survives erasure (undecided)

- **Evidence.** P15-005. Neither erasure path touches `treatment_history`;
  those rows hold health data and outlive a redaction request.
- **Deliberately not "fixed".** It is plausibly correct — clinical records may
  carry a statutory retention duty that outlives an erasure request. Deleting
  them on a guess would destroy records; leaving them silently would mislead.
  The behaviour is therefore disclosed on `/privacy` and raised in
  `docs/legal-review-checklist.md`.
- **Launch: Conditional (legal). Pilot: Conditional. Money: no.**

## R-16 · FIELD_ENCRYPTION_KEY is malformed in production — **P0, LAUNCH BLOCKER**

- **Evidence.** Vercel runtime log, deployment `dpl_AnCxShtJ4zagx87dYhJiG1ZFANUE`,
  `POST /api/cron/audit-digest` → **500**:
  `Error: FIELD_ENCRYPTION_KEY must be "<key-id>:<64-hex-chars>"`.
  That message comes from `parseKeySpec()` in `lib/crypto.ts` on the
  `colon < 1` branch, so the variable **is set** — it simply has no
  `<key-id>:` prefix. Consistent with the monitor reporting
  `missingSecurityEnv=0` for weeks.
- **Probability.** Certain — it is the present state of production.
- **Impact.** **Every** call to `encryptField()` throws. That is not one
  feature; it is:
  - `lib/onboarding.ts:137,144` — **self-service signup returns 500**;
  - `lib/customers.ts:216-217,242-243` — creating or editing a patient with
    allergies or clinical notes returns 500;
  - `lib/platform/mfa.ts:89` — **MFA enrolment returns 500**;
  - break-glass, impersonation and MFA recovery alerts;
  - the weekly audit digest (how it was found).
- **Why it was invisible.** None of those paths had ever executed in
  production. There are no signups, no customers, and no MFA enrolments, so
  nothing had ever asked the encryption layer to do anything. The
  configuration contract checked that the variable was *present*, which it is.
  Presence is not validity.
- **Found by** deploying the P15-003 monitor fix and then the P15-009 outbox
  change, which made the digest the first production code path to call
  `encryptField()`. Neither change caused the defect; they revealed it.
- **Mitigation applied this phase — detection only.** `invalidSecurityEnv` in
  `lib/ops-metrics.ts` validates the *format* of `FIELD_ENCRYPTION_KEY`,
  `AUTH_SECRET`, `RATE_LIMIT_HMAC_KEY` and `EMAIL_PRIVACY_HMAC_KEY`, and the
  monitor's new `production-config-invalid` check fails on it. This would have
  caught it before any user did.
- **Required external action — human only.** Set the production
  `FIELD_ENCRYPTION_KEY` to `<key-id>:<64-hex-chars>`, e.g. `k1:` followed by
  the existing 64 hex characters. **Do not generate a new key** without first
  confirming whether any ciphertext exists; see below. Rotating or reading
  secrets is outside what an agent may do here, so no attempt was made.
- **Data-safety note.** Because `encryptField()` has never once succeeded in
  production, there should be no ciphertext to lose, and simply prefixing the
  existing value is the least invasive fix. Confirm before acting: the
  monitor's retention check reports 0 customers holding PII and the outbox is
  empty, which is consistent with no encrypted rows existing.
- **Residual.** None once corrected and a `POST /api/cron/audit-digest` returns
  200.
- **Launch: BLOCKER. Pilot: BLOCKER. Money: no.**

## R-17 · Monitor incidents were silent (resolved)

- **Evidence.** P15-011. `scripts/production-monitor.mjs` opened incidents with
  a label and no assignee. GitHub notifies on @mentions and assignments, not on
  issue creation, so every incident the monitor raised was silent — including
  the two open right now (#23, #26). `.github/workflows/migrate.yml` had
  already fixed exactly this in SEC-007 after an incident went unnoticed; the
  primary alerting path still had the gap.
- **Status.** **Fixed and proven.** Incidents are assigned to the repository
  owner on open and re-assigned on each still-failing comment, so a snoozed
  notification pings again. Overridable via `INCIDENT_ASSIGNEES` if a rota ever
  exists; degrades to unassigned rather than throwing.
- **Residual.** Still one human receiving the ping (R-11).
- **Launch: resolved. Pilot: resolved.**

## R-18 · Three open incidents, one root cause

- **Evidence.** Production monitor at deployment `dpl_HAqSrW7z2NzfHf8EviyMNW2xRJeJ`
  (`83fbf99`) reports 16/19 with three failures:
  `production-config-invalid`, `audit-digest-stalled`, and `cron-failures`
  (3/10 recent cron runs failed — verified as all three being the
  `audit-digest` job, runs 32192351453, 32187409311, 32182837917).
- **They are not three problems.** All three descend from R-16: the malformed
  `FIELD_ENCRYPTION_KEY` makes `encryptField()` throw, so the digest endpoint
  500s. P15-004 put that endpoint on the hourly schedule, which converted one
  weekly failure into an hourly one and tripped `cron-failures` as well.
- **Foreseeable consequence of a deliberate change.** Moving the digest to the
  hourly cron was correct — it fixed a job that had never once run — but doing
  so while the endpoint was broken made the noise hourly. That is honest rather
  than harmful: every failure is real.
- **Deliberately not silenced.** A "skip when encryption is unavailable" path
  was considered and rejected: it would keep `cron-failures` clean at the cost
  of a branch that could later mask a genuine digest failure, and the condition
  is already named precisely by `production-config-invalid`.
- **Resolution.** All three clear together the moment the key is corrected. If
  the correction is delayed for days, note that `cron-failures` being red
  reduces its sensitivity to an unrelated cron regression — that is the one
  real cost of leaving it.
- **Launch: covered by R-16. Pilot: covered by R-16. Money: no.**

## R-15 · Digest bypassed the outbox (resolved)

- **Evidence.** P15-009. `sendDigestToOwners()` called the email provider
  directly, so a failed digest was logged and dropped, and the freshness metric
  read a table nothing wrote.
- **Status.** **Fixed and proven.** Enqueued to `email_outbox` with encryption
  and a per-ISO-week idempotency key; `tests/phase15-digest-delivery.test.ts`
  asserts the ops metric moves off null as a consequence.
- **Residual.** None known. Delivery now depends on the outbox drain, which is
  already monitored by the outbox-backlog and dead-letter checks.
- **Launch: resolved. Pilot: resolved.**

## R-14 · Browser and accessibility suite did not run in CI

- **Evidence.** P15-006. `.github/workflows/ci.yml` had two jobs
  (`secret-scan`, `quality`) and ended at `npm run build`. No workflow
  referenced Playwright, so 141 checks across three engines and three viewports
  never gated a merge.
- **Status.** **Fixed** — an `e2e` job now runs the `@a11y` and `@responsive`
  tags across all six projects.
- **Residual.** `e2e/signup-scheduler.spec.ts` is still excluded: under
  `next start`, `NODE_ENV=production` makes `SignupForm` fail closed without a
  Turnstile site key, so the submit button never enables. Running it needs
  Cloudflare's public always-pass test keys and matching
  `TURNSTILE_EXPECTED_ACTION` / `TURNSTILE_ALLOWED_HOSTNAMES`. It was not
  disabled or weakened to force a pass.
- **Launch: Accepted. Pilot: Accepted. Money: no.**

---

## Acceptance

| Risk | Owner | Accepted? | Date |
|---|---|---|---|
| R-01 … R-18 | repository owner | ☐ | |

Launch blockers outstanding: **R-16 and R-04.**

R-01 is retracted — the sending domain is verified and was reported broken in
error. R-02 and R-03 are downgraded to hardening now that the subdomain policy
is known to be published.

**R-16 is the priority.** Production's encryption key is malformed, so signup,
patient clinical fields and MFA enrolment all return 500 today. It is a
one-line configuration correction, and nothing can launch until it is made.

**R-04 follows it.** No message has ever been received in a real mailbox and no
`Authentication-Results` header has been inspected. That needs a designated
mailbox and a human, and it cannot even be attempted until R-16 is fixed —
signup fails before any mail is queued.
