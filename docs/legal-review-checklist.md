# Legal review checklist (Phase 15.6)

Status: **EXTERNAL VERIFICATION BLOCKED** — requires a qualified adviser.

The public legal surface exists at `/privacy` and `/terms` and is reachable
without a session. Its text is **draft** and says so on the page. This file is
the gate between that draft and anything anyone should rely on.

Nothing in this repository, and no automated check in it, constitutes legal
review or establishes compliance with any regime.

## How the draft state is enforced

`LEGAL_DOCUMENT_STATUS` in `lib/legal.ts` is `'draft'`. While it holds that
value, `components/legal/LegalPage.tsx` renders an unmissable banner on both
documents stating the text is unreviewed. `tests/phase15-legal-surface.test.ts`
asserts the constant is still `'draft'`, so flipping it is a deliberate,
visible change in a diff — not something that happens by accident.

**Do not set it to `'approved'` until every item below is signed off.** That
value is a representation that a named reviewer approved the exact rendered
text.

## Blocking items — the documents are incomplete without these

- [ ] **Operating entity named.** `OPERATOR_IDENTITY` in `lib/legal.ts` is all
      `null` by design: legal name, company registration number, postal
      address, privacy contact, security contact. A data-protection notice must
      name the controller. Inventing one would misstate who is legally
      responsible, so the pages currently render an explicit "not yet supplied"
      block instead.
- [ ] **Sub-processors listed.** The privacy notice describes them by function
      but does not name them. The actual set is: Vercel (hosting, Frankfurt),
      the managed PostgreSQL provider (EU region), Resend (transactional
      email), Cloudflare (Turnstile bot protection on signup), and the
      error-monitoring service configured in `sentry.*.config.ts`. Confirm this
      list is complete and current before publishing it.
- [ ] **Lawful basis for processing health data.** The schema stores
      `customers.allergies`, `customers.clinical_notes` and
      `treatment_history` — special-category data. The notice describes what is
      stored and how it is protected; it does not assert a lawful basis,
      because that depends on the operator's and each clinic's circumstances.
- [ ] **Controller / processor split.** Each clinic controls its own patient
      records; the operator runs the platform. Whether that makes the operator
      a processor, a joint controller, or both depending on the data, is a
      legal determination that also drives whether a data-processing agreement
      is needed with each pilot organisation.
- [ ] **Georgian law.** The service is at a `.ge` domain and likely serves
      Georgian clinics. The Law of Georgia on Personal Data Protection has its
      own requirements, including for health data, which have not been
      assessed. Confirm whether GDPR also applies (EU hosting, or EU data
      subjects).
- [ ] **P15-005 — treatment history and erasure.** Redaction clears identity,
      contact, clinical notes, allergies and insurance fields, but
      `treatment_history` rows survive. Decide whether that is correct
      (clinical-records retention duty) or a defect (incomplete erasure). The
      privacy notice currently discloses the behaviour and flags it as an open
      question, which is honest but not a resolution. See §"Erasure, and its
      limits" on `/privacy` and the comment in `lib/gdpr.ts`.
- [ ] **Retention period justified.** `organizations.customer_retention_years`
      defaults to 7. Confirm 7 years is the right default for clinical records
      in the target jurisdiction, and that per-organisation override is
      acceptable.
- [ ] **Terms reviewed for what they omit.** `/terms` deliberately contains no
      availability target, support response time, warranty or limitation of
      liability. Those need drafting before any paid or contractual
      relationship, and the page says so.

## Verification items — check the text matches the code

Each claim below was written from the implementation. Re-check them if the
code changes; `tests/phase15-legal-surface.test.ts` pins several but not all.

- [ ] Data categories match `prisma/schema.prisma` (`Customer`,
      `TreatmentHistory`, `Appointment`, `Payment`, `AuditLog`, `MessageLog`).
- [ ] "Encrypted at rest at the field level" is true only of
      `allergies`, `clinical_notes` and `email_outbox.to_address`
      (`lib/crypto.ts`, `lib/customers.ts`). It is not whole-database
      encryption and the notice does not say it is.
- [ ] The redaction field list matches `CUSTOMER_REDACTION_FIELDS` in
      `lib/gdpr.ts`. The notice names insurance policy number specifically; if
      that regresses, the notice becomes false.
- [ ] "The audit log is append-only and cannot be edited or deleted by anyone"
      matches CLAUDE.md invariant 3 and is enforced in the database.
- [ ] Backup residency: the notice states the backup region is **not**
      guaranteed EU-only. `ARCHITECTURE.md` §2 claims EU backups. These
      conflict; the conservative public statement was chosen deliberately.
      Resolve the underlying fact and align both.
- [ ] The pilot limitations in `/terms` match
      `docs/phase-15-risk-register.md` (≈24h backup RPO, no PITR, single
      operator, email authentication incomplete).

## Sign-off

| Field | Value |
|---|---|
| Reviewer name | |
| Qualification / firm | |
| Date reviewed | |
| Document version reviewed | `LEGAL_DOCUMENT_VERSION` in `lib/legal.ts` |
| Approved for publication | ☐ |

On approval: fill the fields above, complete `OPERATOR_IDENTITY`, set
`LEGAL_DOCUMENT_STATUS` to `'approved'`, update the assertion in
`tests/phase15-legal-surface.test.ts` that currently pins it to `'draft'`, and
bump `LEGAL_DOCUMENT_VERSION`.
