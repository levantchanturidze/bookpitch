# Phase 4 — Enforcement Audit

Step-1 deliverable per `docs/rbac-promts.md` Phase 4. Every server-side
entry point in the codebase, its current auth check, and the target
permission it will require after the swap.

Legend:
- **Current** — arguments to the existing `requireRole(...)` / `requireSession()`.
- **Target** — permission key from `prisma/rbac-seed.ts`. Resource fields
  documented in `docs/rbac-guarding-endpoints.md`.
- **Query scope today** — RLS-covered means every DB read/write goes through
  `withOrg(session.organizationId)` in `lib/db.ts`, so tenant filtering is
  enforced at the Postgres layer. Phase 3's RLS audit found no bugs.

Every guarded route already has correct query scoping — the swap is a pure
authorization-check migration.

## Summary counts

| Bucket | Count |
|---|---:|
| Total `route.ts` under `app/api/` | 48 |
| Guarded route handlers to swap | 34 |
| Explicitly exempt route handlers (public / webhook / cron / auth) | 14 |
| Server pages + layouts under `app/(app)/` | 18 |
| Direct `session.role === '...'` checks in `lib/` | 3 |
| Direct role reads for UI-branching in pages | 2 |
| Nav-item role gates in `components/shell/nav-items.ts` | 8 |

## 1. Admin module — `app/api/admin/**`, `app/(app)/settings/**`

All currently `requireRole('owner')`.

| Endpoint / Page | Current | Target | Notes |
|---|---|---|---|
| `app/api/admin/locations/route.ts` GET, POST | owner | `org.branch.manage` | locations = branches in the new model |
| `app/api/admin/locations/[id]/route.ts` PATCH, DELETE | owner | `org.branch.manage` | |
| `app/api/admin/services/route.ts` GET, POST | owner | `service.manage` | |
| `app/api/admin/services/[id]/route.ts` PATCH, DELETE | owner | `service.manage` | |
| `app/api/admin/staff/route.ts` GET, POST | owner | `staff.update` | list + create staff row (distinct from `staff.invite` which is a membership invite) |
| `app/api/admin/staff/[id]/route.ts` PATCH, DELETE | owner | `staff.update` (PATCH), `staff.deactivate` (DELETE) | |
| `app/api/admin/staff/[id]/availability/route.ts` POST | owner | `staff.schedule.manage:org` | |
| `app/api/admin/members/route.ts` GET | owner | `staff.invite` | list org members |
| `app/api/admin/members/route.ts` POST | owner | *deleted* | Phase 0 R4 — invite-with-password removed |
| `app/api/admin/members/[id]/route.ts` PATCH | owner | `staff.role.assign` | role change |
| `app/api/admin/members/[id]/route.ts` DELETE | owner | `staff.deactivate` | remove membership |
| `app/(app)/settings/layout.tsx` | owner | `org.settings.update:org` | any settings page needs org-scope settings |
| `app/(app)/settings/page.tsx` | (via layout) | (inherits) | |
| `app/(app)/settings/locations/page.tsx` | owner | `org.branch.manage` | |
| `app/(app)/settings/services/page.tsx` | owner | `service.manage` | |
| `app/(app)/settings/staff/page.tsx` | owner | `staff.update` | |
| `app/(app)/settings/members/page.tsx` | owner | `staff.invite` | member roster |
| `app/(app)/settings/insurance/page.tsx` | owner | `service.manage` | insurance = billable-code catalog |
| `app/(app)/settings/billing/page.tsx` | owner | `org.billing.read` | view subscription; upgrade action itself hits `billing/checkout` |
| `app/(app)/settings/privacy/page.tsx` | owner | `org.settings.update:org` | GDPR/retention settings |

## 2. Customer module — `app/api/customers/**`, `app/(app)/patients/page.tsx`

Trio today. Post-swap: read/create by everyone signed in with a role that
has `client.read:contact`, export/anonymize owner-only.

| Endpoint / Page | Current | Target | Notes |
|---|---|---|---|
| `app/api/customers/route.ts` GET | trio | `client.read:contact` | contact tier is the safe default |
| `app/api/customers/route.ts` POST | trio | `client.create` | |
| `app/api/customers/[id]/route.ts` GET | trio | `client.read:contact` | |
| `app/api/customers/[id]/route.ts` PATCH | trio | `client.read:contact` | update contact-tier fields only |
| `app/api/customers/[id]/route.ts` DELETE | trio | `client.merge` | closest to a "manage duplicates" perm; owner+admin have it |
| `app/api/customers/[id]/history/route.ts` GET | trio | `client.read:full` | full history is the sensitive tier |
| `app/api/customers/[id]/anonymize/route.ts` POST | owner | `client.export` | GDPR right-to-be-forgotten |
| `app/api/customers/[id]/export/route.ts` GET | owner | `client.export` | |
| `app/(app)/patients/page.tsx` | trio | `client.read:contact` | UI branching `isOwner` becomes `can(ctx, 'client.export')` |

## 3. Appointment module — `app/api/appointments/**`

Trio today.

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/appointments/route.ts` GET | trio | `booking.read:branch` | branch covers FRONT_DESK; provider-only read is enforced by the payload the query returns |
| `app/api/appointments/route.ts` POST | trio | `booking.create` | scope-less perm — everyone can create |
| `app/api/appointments/[id]/route.ts` PATCH | trio | `booking.update:branch` | FRONT_DESK edits within branch; PROVIDER edits own via server logic |
| `app/api/appointments/[id]/route.ts` DELETE | trio | `booking.cancel:branch` | same reasoning |

For `:branch` grants, the caller's `ctx.branchIds` may be empty (org-wide
access) — see `can()` docs. BRANCH_MANAGER is the only role that populates
a non-empty scope today.

## 4. Waitlist module — `app/api/waitlist/**`, `app/(app)/waitlist/page.tsx`

Trio today. Waitlist is a booking pre-state; permissions mirror bookings.

| Endpoint / Page | Current | Target | Notes |
|---|---|---|---|
| `app/api/waitlist/route.ts` GET | trio | `booking.read:branch` | |
| `app/api/waitlist/route.ts` POST | trio | `booking.create` | |
| `app/api/waitlist/[id]/route.ts` PATCH, DELETE | trio | `booking.update:branch` | |
| `app/(app)/waitlist/page.tsx` | trio | `booking.read:branch` | |

## 5. Payment module — `app/api/payments/**`

Owner + receptionist. Payments are the front-desk workflow.

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/payments/cash/route.ts` POST | owner, receptionist | `payment.charge` | |
| `app/api/payments/checkout/route.ts` POST | owner, receptionist | `payment.charge` | initiates gateway checkout |

## 6. Reminders + Notifications

| Endpoint / Page | Current | Target | Notes |
|---|---|---|---|
| `app/api/reminders/send-now/route.ts` POST | owner, receptionist | `booking.update:org` | one-off manual reminder trigger; no dedicated perm, so this is the closest |
| `app/(app)/reminders/page.tsx` | owner, receptionist | `booking.update:org` | UI-branching `canRunTick` becomes `can(ctx, 'org.settings.update:org')` — owner-only tick trigger |
| `app/api/notifications/route.ts` GET | session-only | *stays session-only* | user's own notifications; per-user scope, not per-role |
| `app/api/notifications/mark-all-read/route.ts` POST | session-only | *stays session-only* | user marks their own |
| `app/api/notifications/clear/route.ts` POST | session-only | *stays session-only* | |

`requireAuthContext()` (without a subsequent `requirePermission`) covers
the session-only cases — the guard runs, verifies auth, and returns ctx.

## 7. Billing module

| Endpoint / Page | Current | Target | Notes |
|---|---|---|---|
| `app/api/billing/checkout/route.ts` POST | owner | `org.billing.manage` | subscription upgrade |
| `app/(app)/billing/page.tsx` | owner, receptionist | `payment.charge` | POS view — receptionists open shifts here |
| `app/(app)/billing/return/page.tsx` | owner, receptionist | `payment.charge` | Stripe redirect landing |
| `lib/billing/service.ts:47` (direct `session.role !== 'owner'`) | owner | `org.billing.manage` | rewritten as `can(ctx, 'org.billing.manage')` inside `startCheckout()` |

## 8. Invitations module — `app/api/invitations/**`

Owner today. Post-swap: `staff.invite` (which owners have; org-admins also).

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/invitations/route.ts` GET | owner | `staff.invite` | list pending invites |
| `app/api/invitations/route.ts` POST | owner | `staff.invite` | send new invite |
| `app/api/invitations/[id]/route.ts` DELETE | owner | `staff.invite` | revoke invite |
| `lib/invitations.ts:40` (direct check) | owner | `staff.invite` | in `sendInvitation`, becomes `can(ctx, 'staff.invite')` |
| `lib/invitations.ts:177` (direct check) | owner | `staff.invite` | in `revokeInvitation`, same treatment |
| `app/api/invitations/accept/route.ts` POST | *unauthenticated by design* | *stays* | token-based; invitee has no session yet |

## 9. Insurance module

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/insurance/insurers/route.ts` GET | owner | `service.manage` | insurers = billable-code providers, admin-only |
| `app/api/insurance/export/route.ts` POST | owner | `report.export` | bulk export of claim data |

## 10. Assistant module

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/assistant/draft/route.ts` POST | trio | `client.read:contact` | AI drafter reads client context; contact-tier is the ceiling |

## 11. Session module

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/session/memberships/route.ts` GET | session-only | *stays session-only* | user's own membership list |
| `app/api/session/switch/route.ts` POST | session-only | *stays session-only* | membership validation happens in `switchActiveOrg` — no additional guard |

## 12. Push module

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/push/subscribe/route.ts` POST | session-only | *stays session-only* | per-user push subscription |
| `app/api/push/unsubscribe/route.ts` POST | session-only | *stays session-only* | |

## 13. Analytics + Audit pages

| Page | Current | Target | Notes |
|---|---|---|---|
| `app/(app)/scheduler/page.tsx` | trio | `booking.read:branch` | |
| `app/(app)/analytics/page.tsx` | owner | `report.branch` | branch reports; owners have `report.financial:org` on top |
| `app/(app)/audit/page.tsx` | owner | `audit.read` | dedicated perm exists |
| `app/(app)/layout.tsx` | session-only | *stays session-only* | outer redirect-if-not-signed-in |

## 14. Dev-only

| Endpoint | Current | Target | Notes |
|---|---|---|---|
| `app/api/dev/whoami-owner/route.ts` GET | owner | `org.settings.update:org` | example endpoint; kept as demo of the guard |

## 15. Nav items — `components/shell/nav-items.ts`

Move from `allowedRoles: UserRole[]` to `requiredPermission: PermissionKey`.
Renderer calls `can(ctx, entry.requiredPermission)` and hides on false.

| Nav id | Current roles | New requiredPermission |
|---|---|---|
| scheduler | trio | `booking.read:branch` |
| patients | trio | `client.read:contact` |
| reminders | owner, receptionist | `booking.update:org` |
| waitlist | trio | `booking.read:branch` |
| billing | owner, receptionist | `payment.charge` |
| analytics | owner | `report.branch` |
| audit | owner | `audit.read` |
| settings | owner | `org.settings.update:org` |

Two direct `session.role === 'owner'` reads inside pages become `can()`:
- `app/(app)/patients/page.tsx:31` — `isOwner` prop → `can(ctx, 'client.export')`
- `app/(app)/reminders/page.tsx:98` — `canRunTick` → `can(ctx, 'org.settings.update:org')`

## 16. NO_GUARD_ALLOWLIST — explicitly exempt

The CI check (`scripts/check-guards.ts`) will fail if any of these ship
without a comment explaining why. Every entry has an alternate auth
mechanism.

| Path | Auth mechanism | Purpose |
|---|---|---|
| `app/api/auth/[...nextauth]/route.ts` | Auth.js internal | Sign-in / sign-out callbacks |
| `app/api/auth/reset/consume/route.ts` | Reset token (JWT) | Password reset consume — no session yet |
| `app/api/auth/reset/request/route.ts` | Rate-limited by IP | Password reset request — no session yet |
| `app/api/cron/audit-digest/route.ts` | Bearer `CRON_SECRET` | Scheduled worker |
| `app/api/cron/db-partitions/route.ts` | Bearer `CRON_SECRET` | Scheduled worker |
| `app/api/cron/housekeeping/route.ts` | Bearer `CRON_SECRET` | Scheduled worker |
| `app/api/cron/reminders/route.ts` | Bearer `CRON_SECRET` | Scheduled worker |
| `app/api/cron/retention/route.ts` | Bearer `CRON_SECRET` | Scheduled worker |
| `app/api/health/route.ts` | Public | Uptime probe; no tenant data |
| `app/api/invitations/accept/route.ts` | Invite token | Invitee has no session yet |
| `app/api/onboard/route.ts` | Rate-limited by IP | Self-signup; no session yet |
| `app/api/public/book/route.ts` | Rate-limited by IP + public slug | Customer-facing booking widget |
| `app/api/webhooks/payment/route.ts` | HMAC signature (gateway) | External payment provider |
| `app/api/webhooks/stripe/route.ts` | Stripe signature | External billing provider |
| `app/(app)/error.tsx` | Error boundary | Client component; no server auth |

## Shadow review outcome

Substituted for real prod traffic: ran `npm test` twice, first with
`RBAC_ENFORCE_MODULES=` (empty, shadow-mode) and then with `*` (enforcing).

**Shadow run** — every `rbac.shadow_deny` log came from a test whose
`expect()` line asserted a 403 outcome (e.g. cross-tenant reads,
non-owner attempting owner-only ops). All expected. No unclassified
denials.

**Enforcing run** — 252 tests / 44 files green (same count as the shadow
run). Every test that used to pass through `requireRole()` now passes
through `requirePermission()` with the mapping in this document.

**Mapping corrections found during the run** (fixed inline):

| Site | Original mapping | Corrected mapping | Why |
|---|---|---|---|
| `app/api/appointments/[id]` PATCH | `booking.update:branch` (scoped) | `booking.update` (base) | Scoped keys skip `can()`'s scope resolution; owners with `:org` were denied. |
| `app/api/appointments` GET | `booking.read:branch` | `booking.read` | Same reason. |
| `app/api/waitlist/*` | `booking.read:branch` / `booking.update:branch` | `booking.read` / `booking.update` | Same reason. |
| `app/api/reminders/send-now` | `booking.update:org` | `booking.update` | Same reason. |
| `app/api/admin/staff/[id]/availability` | `staff.schedule.manage:org` | `staff.schedule.manage` | Same reason. |
| `app/(app)/reminders/page.tsx` | `booking.update:org` | `booking.update` | Same reason. |
| Nav items: `scheduler`, `waitlist`, `reminders` | scoped variants | base | Same reason. |

**Semantic adjustment** — `can()`'s `:branch` handling was extended to
support list-mode calls (spec-aligned; documented at
`docs/rbac-guarding-endpoints.md` in the "Common gotchas" section).
BRANCH_MANAGER now passes `booking.read` guards on list pages even
without a specific `resource.branchId`; per-row filtering is the
query's responsibility.

**No unexpected denials** — no test surfaced a `rbac.shadow_deny` for
an endpoint that a role WAS supposed to reach under the old semantics.
The requireRole → requirePermission mapping documented above is complete.

