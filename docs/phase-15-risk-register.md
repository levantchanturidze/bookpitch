# Phase 15 risk register

Every row states current evidence, not an assumption. "Owner accepts" is left
unticked everywhere: that is the repository owner's decision to record, and no
agent can make it on their behalf.

Severity of the launch/pilot columns:
**Blocker** = do not proceed. **Conditional** = proceed only with the stated
mitigation in place. **Accepted risk** = proceed, informed.

---

## R-01 · Sending domain is not email-authenticated

- **Evidence.** `dig @8.8.8.8` on 2026-08-18: no TXT at `bookpitch.ge` (no
  SPF), no DKIM at `resend._domainkey.bookpitch.ge`, no MX. Full table in
  `docs/email-dns-readiness.md`.
- **Probability.** Certain — it is the present state.
- **Impact.** New organisations never receive a verification email, or receive
  one that fails authentication and is filed as spam. Self-service signup is
  the only way in, so this blocks onboarding entirely.
- **Mitigation.** Verify the domain in Resend and publish the DKIM/SPF/MX
  records it issues. Roughly 15 minutes of work plus propagation.
- **Residual.** None once done and proven by a real received message.
- **Launch: Blocker. Pilot: Blocker. Money: no.**
- **External action.** Resend dashboard + Vercel DNS.

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
- **Launch: Blocker. Pilot: Conditional. Money: no.**

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
- **Mitigation applied this phase.** The monitor can now *see* it: P15-003
  replaced a check that passed unconditionally when the digest had never run
  with one that fails when a digest has been due longer than the window
  (`evaluateAuditDigest` in `scripts/production-monitor.mjs`).
- **Residual.** Detection only — the schedule can still be dropped. A durable
  fix moves due-tracking into the hourly job, which needs idempotency in
  `runDigestForAllOrgs()` (it has none today: two calls send two digests).
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
  detection time. No second responder is invented here, because there isn't one.
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
| R-01 … R-14 | repository owner | ☐ | |

Launch blockers outstanding: **R-01, R-02, R-04.** All three are the same
underlying gap — email cannot yet be trusted — and all three are resolved by
publishing DNS records and receiving one authenticated message.
