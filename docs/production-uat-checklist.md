# Production UAT checklist — Phase 15 finalization

This is the production validation matrix for the Phase 15 release candidate.
Use **synthetic data only**. Never enter real customer data. Human-only legal or
operator approvals remain separate from technical UAT.

## Evidence rules

- The designated synthetic mailbox is operator-controlled and its address is
  **redacted** from repository evidence.
- Never commit passwords, MFA secrets, recovery codes, verification URLs,
  `Message-ID` values, provider tracking ids or full recipient addresses.
- Cleanup is by **exact UUID only**. `E2E-PHASE15-` is a recognition prefix,
  never a wildcard selector.
- Audit rows are append-only evidence and are not cleanup targets.

## A. Identity and onboarding

| # | Check | Expected |
|---|---|---|
| A1 | `/signup` renders with Turnstile | real challenge can complete |
| A2 | Submit synthetic mailbox + fresh password + synthetic org | redirect to pending verification; no token in URL |
| A3 | Verification link | first use succeeds; repeat use is harmless |
| A4 | Sign in | role lands on an authorised application surface |
| A5 | Wrong password | generic failure; no account enumeration |

## B. Email delivery and authentication

The production sending domain is **`send.bookpitch.ge`**.

The 2026-09-15 UAT reminder message reached the designated synthetic mailbox.
The inspected authentication result was:

| Check | Expected / current evidence |
|---|---|
| SPF | **pass** |
| DKIM | **pass**, `d=send.bookpitch.ge` |
| DMARC | **pass** |
| Recipient | designated synthetic mailbox; **redacted** |
| Link origin, when present | `https://bookpitch.ge/...` |

Do **not** use the obsolete expectation `d=bookpitch.ge`; the DKIM signing
identity is the sending subdomain. See `docs/email-dns-readiness.md`.

## C. Scheduler / availability

| # | Check | Expected |
|---|---|---|
| C1 | Configure staff availability | persisted count is reported; invalid clocks and overlaps rejected |
| C2 | Explicit day off | picker offers no slots and write path rejects the day |
| C3 | Create one synthetic appointment | appears in scheduler in the correct local month/day/time |
| C4 | Attempt same-staff overlap | one booking only; contender receives slot-taken conflict |
| C5 | Reschedule | current appointment does not block its own slot; alternate slot saves |
| C6 | Race while rescheduling | database exclusion remains authoritative; no 500 |
| C7 | Scoped user | `:own` / `:branch` cannot mutate an out-of-scope appointment by id |

## D. Reminder channel policy

Production reminder health is based on the channels that are actually enabled
by `lib/messaging/channel-policy.ts`.

`SMS_PROVIDER=mock` means **SMS is intentionally deferred in production**. It is
not a provider failure and it must not cause the monitor to require a delivered
SMS. Outside production the mock adapter is executable and can return a mock
provider message id; that environment difference is intentional.

For the current production configuration:

1. Create a synthetic appointment inside the reminder window.
2. Allow the canonical scheduled reminder run to execute naturally.
3. Confirm required-channel delivery (currently email).
4. Confirm deferred/missing SMS does not create a repeating failed row.
5. Confirm the monitor settles incident #90 only from a natural scheduled
   first-attempt run after the corrected release is deployed.

Never close #90 manually as proof of recovery.

## E. Audit

Verify the synthetic create/update/reschedule/cancel and cleanup operations are
visible in the audit surface with the expected actor and entity identifiers.
Do not attempt to delete audit evidence during cleanup.

## F. Cleanup lifecycle

Cleanup only records created by this UAT and resolve every target by its exact
UUID.

| Target | Rule |
|---|---|
| Appointment | cancel/remove only the exact synthetic appointment id |
| Customer | use the privacy/redaction path on the exact synthetic customer id |
| Service | unreferenced service may be deleted; a service with appointment history is **deactivated** so provenance remains |
| Staff | hard delete only when no appointment history exists; historical staff must be preserved rather than bypassing the restrictive FK |
| Location | delete only when dependency guards allow it; never bypass cascade protection |
| Test organisation | suspend/archive if preserving the audit trail is required; do not reset or wildcard-delete production data |

The settings cleanup entrypoints reject names, prefixes and wildcard-like
selectors; destructive cleanup identifiers must be UUIDs.

## G. Release evidence

Record the following against the exact final `main` SHA:

- PR and merge SHA;
- fresh push-CI run and job conclusions;
- production deployment id and both canonical host release headers;
- migration status and drift/invariant verification;
- UAT result matrix;
- synthetic cleanup disposition;
- #90 natural scheduled recovery/closure evidence;
- Sentry release/receipt verification;
- fresh soak issue/controller id and effective UTC start.

A deployment, green CI, or a started soak is **not** terminal success. Technical
finalization is complete only when the canonical controller proves at least 24
uninterrupted hours for that same release and reports its own success verdict.
