# Launch checklist

The single ordered list for taking Bookpitch from "engineering complete" to
"live with a pilot organisation". Items are ticked only against evidence.

Current state: **ENGINEERING COMPLETE — EXTERNAL LAUNCH VERIFICATION BLOCKED.**
Three blockers remain, all email/DNS, all human.

## A. Engineering — done

- [x] Unit + integration suite green (1003 tests, 83 files)
- [x] Browser, mobile and accessibility suite green (177 passed, 6 projects)
- [x] That suite actually runs in CI (`e2e` job) — P15-006
- [x] TypeScript, ESLint, Prettier clean
- [x] Production build succeeds
- [x] `npm audit --audit-level=high` — 0 vulnerabilities
- [x] Gitleaks full history — 0 leaks, suppressions narrow and probe-verified
- [x] Migrations applied and no drift (62)
- [x] Erasure clears every identifying field — P15-002
- [x] Audit-digest monitoring can actually fail — P15-003
- [x] Digest queued durably via the outbox; runs hourly and idempotently — P15-004, P15-009
- [x] Public legal surface exists and is reachable — P15-001
- [x] Production monitor 18/18

## A0. Production configuration — **blocking, do this first**

- [ ] `FIELD_ENCRYPTION_KEY` set to `<key-id>:<64-hex-chars>` (R-16). Today it
      has no key-id prefix, so signup, patient clinical fields and MFA
      enrolment all return 500.
- [ ] Confirm by `POST /api/cron/audit-digest` returning 200
- [ ] Confirm the monitor's `production-config-invalid` check is green

## B. Email and DNS

Already in place — verified 2026-08-18, correcting an earlier erroneous report:

- [x] Sending domain `send.bookpitch.ge` verified in Resend
- [x] DKIM published (`resend._domainkey.send.bookpitch.ge`)
- [x] SPF published (`send.send.bookpitch.ge`)
- [x] Bounce MX published (`send.send.bookpitch.ge`)
- [x] `RESEND_FROM` at the verified domain (Phase 13)
- [x] Provider delivery proven (Phase 13, `delivered@resend.dev`)

**Blocking:**

- [ ] One real message received in a designated mailbox; `spf=pass`,
      `dkim=pass`, `dmarc=pass` read from the actual headers

Hardening, not blocking:

- [ ] `_dmarc.bookpitch.ge` published at `p=none`
- [ ] `rua` points at a mailbox that can actually receive

Detail and exact records: `docs/email-dns-readiness.md`.

## C. Human production UAT — **blocking**

- [ ] Test mailbox designated
- [ ] `docs/production-uat-checklist.md` §A — signup reaches pending
- [ ] §B — verification email received and authenticated
- [ ] §C — activation and sign-in
- [ ] §D — MFA enrolment, recovery codes stored safely
- [ ] §E — one appointment lifecycle
- [ ] §F — one reminder received
- [ ] §G — synthetic records cleaned up
- [ ] §H — outcome recorded with redactions

## D. Legal — conditional

- [ ] Operating entity named in `lib/legal.ts`
- [ ] Sub-processors listed
- [ ] Controller/processor split determined
- [ ] Applicable law confirmed (Georgian law; GDPR if relevant)
- [ ] P15-005 decided — does treatment history survive erasure?
- [ ] Retention default (7 years) confirmed appropriate
- [ ] Reviewer signed off; `LEGAL_DOCUMENT_STATUS` flipped to `'approved'`

Until then, pilot organisations must be told in writing that the documents are
drafts. Detail: `docs/legal-review-checklist.md`.

## E. Repository and operational hardening — non-blocking

- [ ] Dependabot alerts enabled (free, two clicks — R-06)
- [ ] Decide on branch protection (needs a paid plan or public repo — R-07)
- [ ] Reconcile the `ARCHITECTURE.md` EU-backup claim with reality (R-10)
- [ ] Consider Turnstile test keys so the full signup journey runs in CI (R-14)

## F. Pilot readiness

- [x] `docs/pilot-onboarding-runbook.md`
- [x] `docs/support-runbook.md`
- [x] `docs/pilot-plan-and-go-no-go.md` — caps, stop criteria, daily review
- [x] `docs/phase-15-risk-register.md`
- [x] `docs/performance-baseline.md`
- [ ] Owner has accepted each risk explicitly
- [ ] Pilot organisation identified and briefed

## G. Go-live

- [ ] Sections B, C complete; D briefed
- [ ] Owner records the go/no-go decision
- [ ] First organisation onboarded per the runbook
- [ ] Daily review for the first week
