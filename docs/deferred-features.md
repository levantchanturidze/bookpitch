# Deferred Features and Known Gaps

Recorded during Phase 4 sweep (2026-08-12). Each item is stored or partially
wired but has no end-to-end effect at runtime. None are bugs — they are
intentional MVP deferral points. Remove a row when the feature ships.

---

## Schema fields stored but never read in business logic

| Field | Model | Stored via | Never consumed by |
|-------|-------|-----------|-------------------|
| `taxRate` | `Location` | `createLocation` / `updateLocation` | Payment calculation — tax is always excluded from `price`. When billing adds tax support, read this field in `lib/payments/service.ts` and `lib/billing/service.ts`. |
| `locale` | `AppUser` | (schema default) | No route or display path reads it. When locale switching ships, wire it through `AuthContext` and use in `lib/i18n.ts`. |
| `currency` | `Payment` | Hardcoded `'GEL'` at payment creation | Multi-currency support. Until then, `Payment.currency` is always `'GEL'`. |

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
