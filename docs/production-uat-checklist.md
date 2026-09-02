# Production UAT checklist — human steps (Phase 15.4)

This is the minimum production validation that automation cannot safely
perform. Everything here needs a human because it involves entering a password,
solving a real CAPTCHA, reading a real mailbox, or creating real production
records.

**Status: partially performed — see the dated section below.** Everything that
can be proven without a mailbox and without writing production data was
executed against `https://bookpitch.ge` on 2026-09-02 and is recorded there.
Everything that needs a designated mailbox remains **not performed** and is not
claimed anywhere.

No production account was created and no production data was written.

## Before you start

You need a **designated test mailbox** — an address you control, that is not a
real customer's, and that you are willing to see in server-side logs and
support records. Write it down here before starting:

> Designated test mailbox: `________________________`

If you have not designated one, stop: sections A and B cannot be completed, and
they are the ones that prove email delivery works.

**Prerequisite 0 — the database outage is over (2026-09-01).** Production lost
its Supabase project earlier that day and it was restored the same day.
Migration 63 is applied, all production invariants pass, and the monitor
reports the checks live — see
[`docs/release-state.md`](./release-state.md), which links the workflow rather
than restating a count that goes stale. Nothing in this checklist is blocked by
the outage any more. September ledger §17.

**Prerequisite 1 — the encryption key: RESOLVED and VERIFIED 2026-09-01T14:45Z.**
`PASS production-config-invalid — malformed: 0`, and independently a
password-reset request produced an **encrypted** `email_outbox` row, which
cannot exist unless `encryptField()` succeeded. Section A is no longer blocked
by it. Original condition: `FIELD_ENCRYPTION_KEY` lacked its `<key-id>:` prefix,
so `encryptField()` threw and **signup returned 500**. See R-16 in
`docs/phase-15-risk-register.md`.

**What still blocks this checklist is the thing it always said it needed: a
designated test mailbox.** No address has been nominated, so sections A and B —
the ones that prove a real message arrives in a real inbox — cannot be
performed. One transactional message did reach the durable outbox and was sent
during verification, to the operator's own address; whether it landed in that
inbox is unread and unclaimed.

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


---

## Executed against production — 2026-09-02

Everything below was run against `https://bookpitch.ge` and left **no trace**:
verified afterwards against the production database as `outbox status=sent:1`
(unchanged), `verification_tokens=0`, and zero audit rows in the preceding 30
minutes.

### Passed

| Check | Evidence |
|---|---|
| Canonical redirects | `http://bookpitch.ge` → 308 → `https://bookpitch.ge/`; `https://www.bookpitch.ge` → 308 → apex |
| Root requires auth | `https://bookpitch.ge` → 307 → `/signin` |
| Health endpoint | `/api/health` → 200, body exactly `{"ok":true}` |
| TLS | valid to 2026-11-10; `strict-transport-security: max-age=63072000; includeSubDomains; preload` |
| Security headers | CSP with `frame-ancestors 'none'`, `object-src 'none'`; `x-frame-options: DENY`; `x-content-type-options: nosniff` |
| **Tokenless onboarding rejected** | `POST /api/onboard` with no Turnstile token → **400** `{"error":"invalid request"}` |
| **Oversized payload rejected** | `POST /api/onboard` with a ~2 MB body → **413** `{"error":"request too large"}` |
| **Real Turnstile works in a real browser** | `/signup` in Chrome: Cloudflare's script loaded (`window.turnstile` exposes `render`/`execute`/`getResponse`), a genuine 773-character token was issued (prefix `1.kgpb`) into `input[name="cf-turnstile-response"]`, and the **Create workspace button went from disabled to enabled**. This is the complement to the 400 above: the endpoint refuses a request without a token, and the browser really can obtain one |
| Reset enumeration resistance (partial) | Two unknown addresses and one malformed address all returned **202** `{"ok":true}` — identical status and body. No `verification_tokens` row was created, which is the correct behaviour for an unknown address |

### Not performed — needs a designated mailbox

These are the sections that prove **delivery**, and a 200 from a provider is not
delivery. None of them is claimed as done anywhere in this repository.

- Successful onboarding through the real signup form
- Email verification / onboarding email receipt, sender and recipient
- Links in that mail pointing at the production domain
- SPF / DKIM / DMARC results on a received message
- Authenticated login, session persistence and expiry, role landing
- Forbidden-page boundaries and cross-tenant denial as a signed-in user
- Reset enumeration resistance for a **known** address (the unknown half is
  proven above; the pair is what makes it a test)

The last item is the clearest example of why the mailbox blocks this: a reset
for a known address would queue and attempt real delivery. Aiming that at one
of the four reserved-TLD addresses in production would produce a dead letter,
which would then correctly trip `outbox-dead-letters` and block the soak. There
is no safe substitute for an address someone actually controls.
