# Launch: decisions only a person can make

**Status on 2026-10-17: all three open.** Checked against `main` (`fdf6559`) on
that date. Green CI is not evidence for any of these. No agent may guess,
infer or fill in any of them. Each is a representation that a named person
makes.

This list is deliberately separate from the engineering PRs. The engineering
backlog and its release plan are in `docs/post-release-backlog.md`. Owner
decisions that do **not** block launch (the CI audit gate, branch protection,
scheduler fallback, soak reminder-evidence policy, waitlist notifications from
the UI, short lead times) are in its §7.

No longer on this list: **Sentry**, resolved when #44 closed by evidence on
2026-09-08 and verified again for soak #110. **Branch protection** is a
deferred configuration choice with owner acceptance (R-07 in
`docs/phase-15-risk-register.md`), not a launch blocker.

## 1. Approve the published legal text

| | |
|---|---|
| **Decision** | Whether `/privacy` and `/terms` are approved for publication as they render. |
| **Responsible role** | The operator, on the sign-off of a qualified legal reviewer named in the checklist. |
| **Information needed** | Every blocking item in `docs/legal-review-checklist.md`: the sub-processor list confirmed (Vercel, the managed PostgreSQL provider, Resend, Cloudflare Turnstile, the error-monitoring service); the lawful basis for special-category health data (`customers.allergies`, `customers.clinical_notes`, `treatment_history`); the controller/processor split, and whether each pilot organisation needs a data-processing agreement; the Law of Georgia on Personal Data Protection assessed, and whether GDPR applies; P15-005 (`treatment_history` survives redaction: retention duty or incomplete erasure?); the 7-year default retention justified; the terms' omissions (availability, support, warranty, liability). Plus its verification items, including the backup-residency conflict between the notice and `ARCHITECTURE.md` §2. |
| **Where it is configured** | `lib/legal.ts`: `LEGAL_DOCUMENT_STATUS` (`'draft'` → `'approved'`) and `LEGAL_DOCUMENT_VERSION` (bump it). The text is in `app/(legal)/privacy/page.tsx` and `app/(legal)/terms/page.tsx`. The draft banner is in `components/legal/LegalPage.tsx`. The sign-off table is at the end of `docs/legal-review-checklist.md`. |
| **How to verify** | One PR, whose diff: fills the sign-off table (reviewer, qualification or firm, date, version reviewed); flips the constant; bumps the version; and **deliberately updates** the assertion `is still marked draft` in `tests/phase15-legal-surface.test.ts`, which exists so this flip cannot happen by accident. After deploy, `/privacy` and `/terms` render with no draft banner and show the new version. A consent recorded after that carries the new version in `customers.consent_version`, shown in the patient list as "Consent v…". |

## 2. Name the operator

| | |
|---|---|
| **Decision** | Which legal entity operates Bookpitch and is named as controller in the privacy notice. |
| **Responsible role** | The operator: whoever can bind that entity. |
| **Information needed** | All five fields, exactly as registered: legal name, registration number, postal address, privacy contact, security contact. Both contacts must be mailboxes someone monitors. |
| **Where it is configured** | `OPERATOR_IDENTITY` in `lib/legal.ts`, all `null` today by design. While a field is null, the pages render an explicit "not yet supplied" gap instead of a plausible placeholder. |
| **How to verify** | The same PR as item 1, or one before it. The values match the registration record. The test `invents no operator identity` in `tests/phase15-legal-surface.test.ts` asserts every field is null; it is updated **deliberately** to assert the supplied values. After deploy, neither page shows "not yet supplied". A message sent to each contact address is received by a person. |

Item 1 cannot be approved without item 2: naming the operating entity is the
checklist's first blocking item.

## 3. Designate a test mailbox

| | |
|---|---|
| **Decision** | One mailbox that production UAT may use to sign up, verify an address and reset a password, and whose inbox can be inspected. |
| **Responsible role** | The release owner. |
| **Information needed** | The address. Who reads the inbox during UAT, and how: a person reports what arrived, or hands over an already-authenticated session. **Credentials never go into the repository or a log.** Whether an agent may submit sign-up and activation itself; until now it may not. What happens to the test accounts afterwards: kept as sentinels or removed. |
| **Where it is configured** | Nowhere in code. Record the nomination in `docs/release-state.md` ("Designated test mailbox — none nominated") and in row D4 of `docs/finalization-ledger.md`. |
| **How to verify** | A production sign-up to that address in the synthetic UAT setup, with the email **seen in the inbox**. A 200 from the email provider is not delivery. The link activates the account. Then #115's gate: force a resend; exactly one working email arrives, and the monitor's `outbox-dead-letters` check stays green. |

Until this item is done, sign-up and email-receipt UAT has **not** been
performed and must not be claimed. #115's production gate depends on it.
