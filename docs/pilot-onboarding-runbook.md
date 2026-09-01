# Pilot onboarding runbook

How to bring one pilot organisation onto Bookpitch, and what to tell them.

**Prerequisite that is not optional.** Email delivery is not proven
(`docs/phase-15-risk-register.md` R-01, R-04). Onboarding depends entirely on a
verification email arriving. Do not begin until the DNS work in
`docs/email-dns-readiness.md` is done and one real message has been received
and inspected.

## 1. Before you contact them

- [ ] Sending domain verified in Resend; DKIM/SPF present in DNS.
- [ ] `docs/production-uat-checklist.md` completed at least once, by you, with
      a test mailbox — not by the pilot organisation.
- [ ] Legal review status understood. `/privacy` and `/terms` are drafts and
      say so. The pilot organisation must be told this in writing before they
      enter any patient data.
- [ ] You know who their owner will be and that they can receive email.
- [ ] Pilot capacity check: are you inside the caps in
      `docs/pilot-plan-and-go-no-go.md`?

## 2. Set expectations, in writing, first

Send these before they create an account. Each is a real property of the
system today, not boilerplate:

- The legal documents are drafts pending review.
- Backups run daily; up to roughly a day of changes could be lost. Keep their
  own records of anything critical.
- One operator, no 24-hour cover.
- It is a pilot: expect defects, and expect to report them.
- Ask them explicitly to start with **non-sensitive or low-sensitivity data**
  until they are confident. The software stores clinical notes and allergies;
  that is exactly why the first week should not be the whole practice.

## 3. Owner account

The organisation owner does this themselves. Do not create it for them, and
never ask for or set their password (invariant 6).

1. They open `https://bookpitch.ge/signup`.
2. They complete Turnstile, choose their organisation name, and submit.
3. They land on `/onboard/pending`.
4. They open the verification link from their email.
5. They sign in.

If the email does not arrive within a few minutes, go to
`docs/support-runbook.md` §5 — do not have them retry repeatedly, the resend
path is rate limited to one per 5 minutes by design.

## 4. Organisation configuration

Walk through in this order; later steps depend on earlier ones.

| # | Step | Where | Note |
|---|---|---|---|
| 1 | Organisation identity, timezone, locale, currency | `/settings` | Timezone drives every appointment boundary — get it right before any booking exists |
| 2 | Location(s) | `/settings/locations` | `clinic` or `salon`; type affects the branch accent and available modules |
| 3 | Services with duration and price | `/settings/services` | Duration determines slot length |
| 4 | Staff / practitioners | `/settings/staff` | |
| 5 | Staff availability | `/settings/staff` → availability | Slots come from this; without it nothing is bookable |
| 6 | Retention window | `/settings/privacy` | Defaults to 7 years — confirm it suits them |
| 7 | Organisation toggles | `/settings` | Enable only what they will use |
| 8 | Additional members | `/settings/members` | See §5 |

Verify configuration took effect rather than merely saved: open `/scheduler`
and confirm bookable slots appear at the expected local times.

## 5. Roles

Grant the least role that does the job. The organisation plane, by rank:

| Role | For | Notes |
|---|---|---|
| `ORG_OWNER` | The person accountable for the organisation | At least one must always exist; the last one cannot be removed |
| `ORG_ADMIN` | Day-to-day administration | Cannot act on anyone at or above their own rank |
| `BRANCH_MANAGER` | Runs one location | Scoped to their branch |
| `SENIOR_PROVIDER` | Practitioner with wider access | |
| `PROVIDER` | Practitioner | Own schedule and their own patients |
| `FRONT_DESK` | Reception | Booking and contact details, not clinical notes |
| `ACCOUNTANT` | Billing and reporting | No clinical access; lands on `/analytics`, not `/scheduler` |
| `MARKETING` | Contact-level client data and reports | No booking access; lands on `/patients` |

Nobody can grant a role at or above their own rank. If a role change appears
not to have taken effect, the user's session may need re-establishing.

## 6. First-week checks

Daily, for the first week:

- [ ] Production monitor green, and reporting **20** checks. Ten of them come from `/api/health/ops`; a run that reports only ten has not passed them, it never evaluated them.
- [ ] Outbox: `pending` not climbing, `dead` still 0.
- [ ] No open incident issue.
- [ ] Ask the organisation directly whether anything looked wrong. They will
      not report S3 issues unprompted.

## 7. Offboarding

See `docs/support-runbook.md` §9. Suspend before deleting; export before
redacting; never delete while the retention question in
`docs/legal-review-checklist.md` is open.
