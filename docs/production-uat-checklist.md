# Production UAT checklist — human steps (Phase 15.4)

This is the minimum production validation that automation cannot safely
perform. Everything here needs a human because it involves entering a password,
solving a real CAPTCHA, reading a real mailbox, or creating real production
records.

**Nothing in this checklist has been performed.** No production account was
created and no production data was written by Phase 15.

## Before you start

You need a **designated test mailbox** — an address you control, that is not a
real customer's, and that you are willing to see in server-side logs and
support records. Write it down here before starting:

> Designated test mailbox: `________________________`

If you have not designated one, stop: sections A and B cannot be completed, and
they are the ones that prove email delivery works.

**Blocking prerequisite 0 — production has no database (2026-09-01).** The
Supabase project behind production no longer exists, so every DB-backed route
returns 500 and **nothing in this checklist can be attempted**. This supersedes
prerequisite 1 below: until a database exists, the encryption key cannot be
exercised either. See
[`docs/phase-17-september-release-ledger.md`](./phase-17-september-release-ledger.md)
§2 for the evidence and the exact restore steps.

**Blocking prerequisite 1 — the encryption key.** *Superseded 2026-08-22, but
unverified.* A correctly prefixed `<key-id>:<64-hex>` value was provisioned on
2026-08-22; no monitor run has confirmed it, because `/api/health/ops` has never
been reachable since. Treat this as `NOT VERIFIED`, not as fixed, and re-check
it as the first thing after the database is restored. Original condition:
`FIELD_ENCRYPTION_KEY` lacked its `<key-id>:` prefix, so `encryptField()` threw
and **signup returned 500**. See R-16 in `docs/phase-15-risk-register.md`.

**Blocking prerequisite 2 — nothing.** An earlier revision claimed the sending
domain was unverified. That was wrong: `send.bookpitch.ge` has DKIM, SPF and a
bounce MX published, and Phase 13 proved provider-level delivery. Section B is
expected to work once prerequisite 1 is fixed. See
`docs/email-dns-readiness.md` §2.

Redaction rule for anything you record: no passwords, no recovery codes, no MFA
secrets, no verification-token URLs, no full email addresses in screenshots.
Blur or crop before saving.

---

## A. Signup reaches pending verification

| # | Step | Expected | Result |
|---|---|---|---|
| A1 | Open `https://bookpitch.ge/signup` | Page renders; a Cloudflare Turnstile widget is visible | |
| A2 | Confirm the privacy and terms links are present under the form | Both link out and open; both show the "Draft — not legally reviewed" banner | |
| A3 | Fill in the designated test mailbox, a password you generate fresh, and organisation name `E2E-PHASE15-Pilot-Test` | Submit button enables only after Turnstile solves | |
| A4 | Submit | Redirect to `/onboard/pending`; no token visible in the URL | |
| A5 | Note the UTC timestamp | | |

If the submit button never enables, the Turnstile site key is missing or wrong
in production — see `REQUIRED_SIGNUP_ENV` in `lib/ops-metrics.ts`.

## B. Verification email arrives and authenticates

| # | Step | Expected | Result |
|---|---|---|---|
| B1 | Check the test mailbox inbox | Message arrives within ~2 minutes | |
| B2 | If not in inbox, check spam | Record which folder it landed in — this is the deliverability result | |
| B3 | Inspect the sender | `From` is at `bookpitch.ge`, not `resend.dev` | |
| B4 | View the raw message headers | | |
| B5 | In `Authentication-Results`, read `spf=` | `pass` | |
| B6 | In `Authentication-Results`, read `dkim=` | `pass`, with `d=bookpitch.ge` | |
| B7 | In `Authentication-Results`, read `dmarc=` | `pass` | |
| B8 | Check `Return-Path` | A `bookpitch.ge` subdomain, aligned with the `From` domain | |
| B9 | Check the verification link's origin | `https://bookpitch.ge/...` — not a preview URL, not an IP | |

Record the three authentication verdicts. Redact the recipient address and the
`Message-ID` before pasting results anywhere.

**If B5–B7 do not all say `pass`, email is not launch-ready.** That is the
expected outcome today given the missing DNS records.

## C. Activation and sign-in

| # | Step | Expected | Result |
|---|---|---|---|
| C1 | Open the verification link | Lands on `/onboard/success` | |
| C2 | Open the same link a second time | Handled gracefully — no error page, no second organisation created | |
| C3 | Sign in at `/signin` with the credentials from A3 | Reaches the application | |
| C4 | Enter a deliberately wrong password once | Generic failure message that does not reveal whether the account exists | |

## D. MFA enrolment

Only if the account you created is a platform-plane user; organisation owners
follow whatever the product presents.

| # | Step | Expected | Result |
|---|---|---|---|
| D1 | Complete TOTP enrolment | QR renders; authenticator accepts | |
| D2 | Confirm with a generated code | Enrolment completes | |
| D3 | Store the recovery codes in a password manager | Never in a screenshot, a note, or this file | |
| D4 | Sign out and back in | TOTP is required | |

## E. Minimal pilot data and one appointment lifecycle

Create as little as possible, and prefix everything `E2E-PHASE15-` so cleanup
in section F is unambiguous.

| # | Step | Expected | Result |
|---|---|---|---|
| E1 | Create one location, one service, one staff member, all prefixed | Saved and visible | |
| E2 | Create one customer named `E2E-PHASE15-Test-Patient`, with **no real personal or health data** | Saved | |
| E3 | Book an appointment for that customer | Appears on the scheduler | |
| E4 | Attempt a conflicting booking in the same slot | Rejected | |
| E5 | Reschedule the appointment | Reflected on the scheduler | |
| E6 | Cancel it | Status updates | |
| E7 | Check the audit page | The above actions appear | |

## F. Reminder / notification

| # | Step | Expected | Result |
|---|---|---|---|
| F1 | Create an appointment inside the reminder window | Reminder is queued | |
| F2 | Wait for the reminders cron (runs every 15 minutes) | Message is sent | |
| F3 | Confirm receipt in the test mailbox | Arrives; content correct; no token or internal detail leaked | |

## G. Cleanup

Delete or archive **only** the records you created, by exact identifier. Never
run a wildcard delete against production.

| # | Step | Result |
|---|---|---|
| G1 | Cancel/remove the `E2E-PHASE15-` appointments | |
| G2 | Redact `E2E-PHASE15-Test-Patient` via the privacy tooling | |
| G3 | Remove the `E2E-PHASE15-` service, staff and location | |
| G4 | Decide the fate of the test organisation — suspend it rather than deleting if the audit trail is worth keeping | |

Audit-log rows are append-only and will remain. That is by design; do not
attempt to remove them.

## H. Record the outcome

| Field | Value |
|---|---|
| Performed by | |
| Date / UTC times | |
| Sections completed | |
| SPF / DKIM / DMARC verdicts (B5–B7) | |
| Inbox or spam (B2) | |
| Defects found | |
| Production records left behind | |

File the completed table in this repository, with all redactions applied.
