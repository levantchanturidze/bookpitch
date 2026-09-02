# Deferred Features and Known Gaps

Recorded during Phase 4 sweep (2026-08-12). Each item is stored or partially
wired but has no end-to-end effect at runtime. None are bugs — they are
intentional MVP deferral points. Remove a row when the feature ships.

---

## Outbound providers — the authoritative deferral decision

This section is the record `lib/ops-metrics.ts` `PROVIDER_CONTRACT.deferrable`
mirrors, and the only thing that entitles a provider to a PAUSED status in the
production monitor.

The distinction matters because it used to be inferred. Any provider set to
`mock` was reported as "a deliberate pre-launch gate", read straight off the
value of the environment variable. But whether a feature may ship deferred is a
product decision, not a property of a string. Under the old rule a mocked
**email** provider — which means nobody can complete signup, reset a password
or receive an audit digest — would have been reported as a deliberate pause,
in green-adjacent grey, forever.

| Variable | Deferral accepted? | Why |
|---|---|---|
| `EMAIL_PROVIDER` | **No** | Signup verification, password reset and the audit digest all go through it. On `mock` nothing is delivered and signup cannot complete, so `mock` here is a FAULT, not a pause. |
| `SMS_PROVIDER` | **Yes** | SMS reminders are a post-pilot feature. Appointments still remind by email. Accepted for launch and pilot. |
| `PAYMENT_GATEWAY` | **Yes** | Online payment is not in the pilot scope; bookings are settled in person. Accepted for launch and pilot. |

Enabling either deferred provider is a launch-checklist item, not a monitor
fix: do not set a real adapter merely to clear a PAUSED line.

**What each adapter requires.** The monitor checks these against whichever
adapter is selected, so choosing Postmark stops demanding Resend's variables
and starts demanding Postmark's:

| Adapter | Variables |
|---|---|
| `EMAIL_PROVIDER=resend` | `RESEND_API_KEY`, `RESEND_FROM` |
| `EMAIL_PROVIDER=postmark` | `POSTMARK_API_TOKEN`, `POSTMARK_FROM` |
| `SMS_PROVIDER=smsoffice` | `SMSOFFICE_API_KEY`, `SMSOFFICE_SENDER` |
| `PAYMENT_GATEWAY=bog` / `bog_ipay` | `BOG_CLIENT_ID`, `BOG_CLIENT_SECRET`, `BOG_WEBHOOK_PUBLIC_KEY` |
| `PAYMENT_GATEWAY=tbc` / `tbc_ecommerce` | `TBC_API_KEY`, `TBC_CLIENT_ID`, `TBC_CLIENT_SECRET`, `TBC_WEBHOOK_SECRET` |

An **unset** provider variable is a fault, not a deferral. `getGateway()` and
`getSmsProvider()` refuse to default to the mock adapter in production and
throw on the first call; before this contract existed neither variable belonged
to any required-variable set, so unsetting one left every configuration count
at zero while the feature was dead.

---

## Schema fields stored but never read in business logic

| Field | Model | Stored via | Never consumed by |
|-------|-------|-----------|-------------------|
| `taxRate` | `Location` | `createLocation` / `updateLocation` | Payment calculation — tax is always excluded from `price`. When billing adds tax support, read this field in `lib/payments/service.ts` and `lib/billing/service.ts`. |
| `locale` | `AppUser` | (schema default) | No route or display path reads it. When locale switching ships, wire it through `AuthContext` and use in `lib/i18n.ts`. |

---

## Dead code / never-called helpers

| Symbol | File | Reason unused |
|--------|------|---------------|
| `formatDate(d, locale)` | `lib/i18n.ts` | No caller. Date formatting moved to `lib/tz.ts` helpers (`toLocalDate`, `formatLocalDateTime`). Delete `formatDate` when confident no caller will be added. |
| `formatCurrency(amount, currency, locale)` | `lib/i18n.ts` | No caller outside the module itself. Wire it to payment display surfaces when multi-currency or per-org locale lands. |

---

## Slot computation gaps (no schema model)

These constraints would need schema migrations before they can be enforced
in `getAvailableSlots`:

| Feature | What's missing |
|---------|----------------|
| **Staff blocked time** | `StaffBlockedTime` model — date/time ranges when a staff member is unavailable (holiday, personal leave). |
| **Location working hours** | `LocationHours` model — per-weekday open/close times independent of staff availability. `Location.timezone` is stored but no open/close fields exist. |
| **Rooms / resources** | No `Room` or `Resource` model. Multi-room clinics cannot enforce room capacity. |
| **Buffer time** | No `bufferMinutes` field on `Service` or `Staff`. Back-to-back appointments are allowed; adjacent starts are not blocked by any gap. |
