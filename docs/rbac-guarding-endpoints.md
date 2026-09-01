# Guarding a new endpoint (Phase 3+)

This document is the calling convention for `lib/rbac`. It's the successor
to the `requireRole()` pattern that still lives in ~41 route handlers.
Phase 3 introduced these primitives; Phase 4 does the swap.

If you're adding a new route handler or server action, start here.

## The two-line pattern

```ts
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withApi } from '@/lib/auth';

export async function POST(req: Request) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'booking.update', {
      organizationId: ctx.activeOrganizationId!,
      branchId: '<from-request-or-DB>',
      ownerUserId: '<the-actor-owner-if-relevant>',
    });
    // …handler…
  });
}
```

- `requireAuthContext()` throws `UnauthenticatedError` (401) on no session.
- `requirePermission(ctx, key, resource?)` throws `ForbiddenError` (403) if
  `can()` returns false. Both errors are mapped to HTTP by `withApi`.

That's the whole guard. Any additional logic (rate limiting, input parsing,
etc.) happens after the guard passes.

### Pages and layouts use a different form (P17-013)

A **route handler** keeps `requirePermission`, exactly as above: `withApi`
catches `ForbiddenError` and answers `403` with a JSON body its callers parse.

A **page or non-root layout** uses `requirePagePermission` from the same barrel:

```ts
const ctx = await requireAuthContext();
requirePagePermission(ctx, 'booking.read', { organizationId: ctx.activeOrganizationId! }, 'appointments');
```

Same decision, same `rbac.enforce_deny` log line, same `RBAC_ENFORCE_MODULES`
behaviour — only the refusal differs. It calls Next's `forbidden()`, so Next
renders the nearest `forbidden.tsx` (`app/(app)/` and `app/platform/` each have
one) with a real `403`.

The split exists because nothing catches a thrown error during a server render:
Next treats it as an unhandled server error and answers `500`, and it strips
`error.name` before the error reaches the client, so an error boundary cannot
tell a denial from a crash. Measured before the fix — MARKETING opening
`/scheduler`, `/audit`, `/settings` and `/patients` received `500` and
"Something went wrong".

Do **not** use `requirePagePermission` in a route handler: `withApi`'s catch
would swallow the interrupt, which is the documented way to lose it.
`tests/phase17-forbidden-boundary.test.ts` fails if either side of the split is
crossed.

## Choosing the permission key + scope

Permission keys live in the `permissions` table (see `prisma/rbac-seed.ts`
for the source of truth). The suffix after `:` is the scope. Pick per
sensitivity:

| Scope | Meaning | When to use |
|---|---|---|
| `:own` | Actor's own record | The user is editing something they created. `booking.update:own`, `booking.cancel:own`. |
| `:branch` | Actor's assigned branches | Front-desk / branch-manager operations. `booking.read:branch`, `staff.schedule.manage:branch`. |
| `:org` | Anywhere in the tenant | Owners/admins. `booking.update:org`, `client.merge`. |
| `:platform` | Bookpitch staff only | `platform.audit.read`, `platform.org.suspend`. Bypasses tenant isolation entirely. |
| `:basic \| :contact \| :full` | Client-detail tier | `client.read:basic` (name + time only), `:contact` (+ phone/email), `:full` (+ full history). |
| `:limited \| :unlimited` | Discount ceiling | `payment.discount:limited` (org-configured cap), `:unlimited` (owner). |

Scope-less keys (e.g. `booking.create`, `client.create`) are actions with
no per-resource cardinality — presence in the role's grant set is the whole
check.

## When to use `can()` vs `requirePermission()`

`requirePermission()` throws on deny — use it for **mutating** endpoints and
for entry points where a 403 is the correct outcome.

`can()` returns a bool — use it for:

- **UI branching**. `{can(ctx, 'booking.update', ...) && <EditButton />}`.
  This is called from a server component where you've already built the ctx.
- **List filtering**. When rendering a page that mixes owned and unowned
  rows, use `can()` per-row to decide which get an Edit link.
- **Multiple permission alternatives**. If either of two perms authorises
  the action, `can()` twice and OR the results — cleaner than nested
  try/catch on `requirePermission()`.

Never call `can()` inside a mutating handler as the sole guard. If you
mean "deny on false", say so with `requirePermission()` — a boolean check
you forget to invert produces a silently open endpoint.

## Building the Resource object

The optional third argument to `can()` / `requirePermission()` is what
converts scope suffixes into resource-level checks. Fill only the fields
you need:

```ts
// The actor is editing THEIR booking (owner=self):
requirePermission(ctx, 'booking.update', {
  organizationId: ctx.activeOrganizationId!,
  ownerUserId: ctx.userId,
});

// A branch manager editing anyone's booking within their branch:
requirePermission(ctx, 'booking.update', {
  organizationId: ctx.activeOrganizationId!,
  branchId: booking.branchId,
});

// Anywhere-in-org read:
requirePermission(ctx, 'booking.read', {
  organizationId: ctx.activeOrganizationId!,
});
```

Rules of thumb:

- **Always** include `organizationId`. The tenant isolation branch is
  cheap belt-and-braces on top of RLS. Omitting it means "no tenant
  constraint" — do not do that for tenant-scoped data.
- Only include `branchId` when checking a `:branch` grant. Otherwise it's
  ignored.
- Only include `ownerUserId` when checking a `:own` grant. Otherwise it's
  ignored.
- Never build the Resource from user input without validation. The
  `organizationId` should come from `ctx.activeOrganizationId` or from a
  DB row the handler just fetched — never from a request body field.

## Role management (Phase 6 preview)

If your endpoint changes a member's role, use `canManageRoleAssignment`
in addition to the guard:

```ts
import { canManageRoleAssignment } from '@/lib/rbac';

const allowed = await canManageRoleAssignment(ctx, targetRoleKey);
if (!allowed) throw new ForbiddenError('cannot manage that role');
```

This enforces two things at once:
1. Numeric rank — actor.rank > target.rank (no self-promotion).
2. Explicit lattice — the actor's role has an `role_can_manage` edge to
   the target. Peer roles (FRONT_DESK ↔ PROVIDER at rank 40) fail here.

Phase 6 wires this into `admin.ts::updateMemberRole` etc. In Phase 3+, use
it any time you're persisting a change to `memberships.role_id`.

## Testing checklist

For each guarded endpoint, add a test that covers:

- **200/302 path**: an authorised caller reaches the handler. Assert the
  side effect landed.
- **401 path**: no session → `UnauthenticatedError` → 401 response.
- **403 path**: session with the wrong role → `ForbiddenError` → 403
  response. Do this for at least one role that lacks the permission.
- **Cross-tenant path**: session for org A tries to act on a resource
  whose `organizationId = B` → 403. This is the most common way a Phase 4
  swap can regress silently.
- **Scope resolution**: for `:own` or `:branch` grants, verify that a
  same-org caller who fails the scope check gets 403.

Use the multi-tenant fixtures in `prisma/rbac-fixtures.ts`:
- `moonlight@bp.test` — PROVIDER in Grand Medical AND Split Practice (multi-org)
- `splitmgr@bp.test` — BRANCH_MANAGER scoped to 2 of 3 Split branches
- `solo@bp.test` — solo practitioner in Solo Practice
- `split-owner@bp.test` — ORG_OWNER in Split Practice

## Common gotchas

- **AuthContext is cached** for 30s per (membership, sessionVersion). A
  role change won't propagate mid-request. If you need immediate
  invalidation (e.g. after a permission change in a test), bump
  `sessionVersion` on the user and the next `buildAuthContext` will
  rebuild.
- **`branchIds` empty means unrestricted**, not "no access". FRONT_DESK
  has `booking.read:branch` but no branch scope — that means "read
  anywhere in the org". BRANCH_MANAGER also has `:branch`, but with
  populated `branchIds` — that scopes them down.
- **Suspended org denies everything**. If a user complains their perms
  suddenly stopped working, check `organizations.status`. Suspended and
  archived orgs deny every org-plane action regardless of grants.
- **Platform-only sessions have no active org**. A user with only
  `platform_role_id` set (no memberships) gets `activeOrganizationId=null`.
  `can()` denies every non-`platform.*` permission for them. This is
  intentional — Bookpitch staff should sign in with an org context to
  act on org data.

## What Phase 3 does NOT do

- It does not wire this into any existing endpoint. Phase 4 does the
  ~41-callsite swap module by module.
- It does not populate `RESTRICTED_DURING_IMPERSONATION`. That's Phase 5,
  when the impersonation flow is built out.
- It does not enforce "≥1 active ORG_OWNER" — that's a Phase 6 admin-flow
  concern (blocking the last-owner demote/remove).

---

## Phase 4 enforcement

### Runtime toggle: `RBAC_ENFORCE_MODULES`

`requirePermission()` picks its mode from the env var:

- `RBAC_ENFORCE_MODULES=` (empty) — shadow mode across every module. Denies
  are logged as `rbac.shadow_deny` and the request proceeds.
- `RBAC_ENFORCE_MODULES=*` — enforcing across every module. **Default in
  tests and production.**
- `RBAC_ENFORCE_MODULES=admin,customers` — enforcing for the listed
  modules only; the rest stay in shadow.

The module key is the fourth argument to `requirePermission(ctx, key,
resource, module)`. Modules used today: `admin`, `customers`,
`appointments`, `waitlist`, `payments`, `billing`, `reminders`,
`invitations`, `insurance`, `settings`, `assistant`, `analytics`,
`audit`, `dev`. New modules should be added consistently — pick the
directory name under `app/api/`.

Rollback lever: if a Phase 4 swap breaks something in prod, set
`RBAC_ENFORCE_MODULES=` (empty) at the platform level. The runtime falls
back to shadow immediately; no redeploy. Old routes stay authorized-by
whatever the caller happens to have; new-guard denies get logged but
don't 403 anyone. Investigate via `rbac.shadow_deny` log entries.

### Shadow log format

```json
{
  "level": "warn",
  "msg": "rbac.shadow_deny",
  "permission": "client.export",
  "module": "customers",
  "userId": "…",
  "membershipId": "…",
  "activeOrganizationId": "…",
  "roleKey": "FRONT_DESK",
  "resource": { "organizationId": "…" }
}
```

If you see `rbac.shadow_deny` for a real user, it means either (a) the
mapping in `docs/rbac-enforcement-audit.md` is wrong, or (b) the caller
was hitting an endpoint they were never supposed to access under the old
role checks either. Classify each occurrence before flipping the module
to enforcing.

`rbac.enforce_deny` is the same shape but fires only in enforcing mode
and precedes a 403. It surfaces the same information; use both when
diagnosing incidents.

### CI guard scanner: `npm run test:guards`

`scripts/check-guards.ts` walks every route handler and server page and
verifies each contains a `requireAuthContext(` / `requirePermission(` /
`requireSession(` call. Files in `NO_GUARD_ALLOWLIST` are exempt.

To add a new exempt path (webhook, cron job, public widget, invite-token
consumer), edit the array in `scripts/check-guards.ts` with a comment
explaining the alternate auth mechanism. The audit trail lives in git.

The check is wired into `npm test` — if a PR adds an un-guarded route,
`npm test` fails before any e2e traffic sees it. It also fails on stale
allowlist entries (files removed but the allowlist forgot), keeping the
list honest.

### Deleted paths

- `lib/auth.ts::requireRole()` — replaced by `requireAuthContext() +
  requirePermission()`. Grepping for `requireRole` should return zero
  application-code hits post-Phase-4.
- `lib/admin.ts::inviteMember()` — replaced by `lib/invitations.ts::createInvitation`
  (token-based flow). The old function let admins set passwords directly,
  which violates spec §9 rule 4.
- Legacy JWT aliases `organizationId` + `role` — the Phase 3 compat
  layer is gone. Only `activeOrganizationId`, `membershipId`, and
  `platformRoleId` remain.

### Passing scoped vs base permission keys

Common footgun: `booking.read:branch` looks like a permission but is a
COMPLETE key (the seed defines all three variants). Pass the BASE key
(`booking.read`) to `requirePermission` and let `can()` walk `:org →
:branch → :own`. Passing the scoped variant bypasses scope resolution
and produces false denies for callers with a stronger scope.

Exception: tier-suffixed keys (`client.read:contact`, `client.read:full`,
`payment.discount:limited`) are terminal — pass them verbatim. `can()`
doesn't walk tiers.

---

## Phase 5 — Platform-plane routes

### The platform wrapper

Every route under `app/api/platform/**` uses `withPlatformApi` instead of
plain `withApi`:

```ts
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';

export async function GET() {
  return withPlatformApi('org.list', async (ctx) => {
    requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
    return { orgs: await listOrganizations() };
  });
}
```

The first argument is a stable per-endpoint action label (`org.list`,
`org.detail`, `audit.query`). If the caller has an active break-glass
session, the wrapper writes an `audit_log` row on successful return
tagged `break_glass.read.<action>` with `break_glass_session_id` —
spec §7.2 rule 6. Never call `withPlatformApi` for mutations that would
also be captured by an explicit audit row (double-audit is harmless but
noisy).

### Gating a destructive action

Spec §9 rule 9 requires password re-entry for destructive actions.
Standard pattern:

```ts
import { requireFreshPassword } from '@/lib/platform/password-reauth';

export async function POST(req: NextRequest, { params }: ...) {
  return withPlatformApi('org.suspend', async (ctx) => {
    requirePermission(ctx, 'platform.org.suspend', undefined, 'platform');
    requireFreshPassword(ctx.userId);         // ← 403 unless verified <60s ago
    // …destructive work…
  });
}
```

Client-side flow:
1. UI prompts the caller for their password.
2. UI POSTs to `/api/platform/reauth` with `{ password }`.
3. UI immediately POSTs the destructive action; the guard sees the
   fresh marker and allows.

`freshAuth()` in `components/platform/OrgDetail.tsx` is the reference
implementation.

### Starting an impersonation

Callers with `platform.impersonate` (SUPER_ADMIN + PLATFORM_ADMIN by
default) can start a session:

```ts
POST /api/platform/impersonate
{ organizationId, targetUserId, reason, ticketId }
```

Fails 400 when `organizations.allow_support_impersonation=false` unless
the caller is in an active break-glass session (spec §6.1 override).
On success, bumps caller's sessionVersion; within ~5s the AuthContext
cache rebuilds and `ctx.impersonation` is populated. The `(app)/Shell`
renders `PlatformSessionBanner` when either flag is set — the caller
sees the amber banner on every org-plane page.

Restricted permissions during the session are defined in
`lib/rbac/impersonation.ts::RESTRICTED_DURING_IMPERSONATION`. Attempts
to perform a restricted action fall through `can()` to `false` and
return 403 as normal.

### Starting a break-glass

SUPER_ADMIN only. Requires password re-verification IN THE REQUEST,
not just via `/api/platform/reauth` — the flow does its own verify:

```ts
POST /api/platform/break-glass
{ password, reason, ticketId, targetOrganizationId? }
```

TODO: 2FA/TOTP is not enforced yet (see
`docs/rbac-schema-notes.md §8.3`). When we install `otplib`, the
`password` field becomes `{ password, totpCode }` and the flow refuses
without both.

### Testing the impersonation-blocked-action path

`tests/platform-impersonation.test.ts` "RESTRICTED perms deny during
impersonation" is the reference — insert an impersonation_sessions row
for the caller, build a JWT that also carries an org membership so the
caller's ctx has ORG_OWNER perms, then assert `can(ctx, 'org.delete',
...)` returns false while the session is active. `beforeEach` cleans
the sessions table so cross-test pollution can't cause a flake.

### The NO_GUARD_ALLOWLIST doesn't apply here

Every platform route MUST call `requirePermission`. There is no
password-reset-style "reachable without auth" exception on the platform
side. `scripts/check-guards.ts` scans `app/(platform)/**` +
`app/api/platform/**` alongside the org-plane routes.

---

## Phase 6 — Org-plane policy

### Per-org toggles

`ctx.orgToggles` carries the four Phase 6 toggle fields (populated by
`buildAuthContext` from `organizations.features` JSONB). `can()`
consults specific fields for the three gated permissions:

| Permission | Role | Toggle |
|---|---|---|
| `clinical_note.read:any` | PROVIDER | `providerClinicalNotesOthers` |
| `report.financial:org` | PROVIDER | `providerFinancialReports` |
| `client.read:full` | FRONT_DESK | `frontdeskClientFullHistory` |

Toggle-off returns `false` from `can()` regardless of scope resolution
— the role's default grant is `false` when the toggle is off, `true`
when on. Consumers don't need to consult toggles directly; a plain
`requirePermission(ctx, key, ...)` does the right thing.

The fourth toggle (`frontdeskDiscountCeiling`, numeric) is NOT a scope
check. Payment code calls
`assertDiscountWithinCeiling(orgId, actorRoleKey, discountAmount)` from
`lib/payments/service.ts` before persisting a discount. Passing a
non-FRONT_DESK role is a no-op.

### Branch scoping for BRANCH_MANAGER

When a caller with `ctx.branchIds.size > 0` hits a list endpoint,
filter the query to their scope:

```ts
import { scopedLocationIds } from '@/lib/rbac';

const scoped = await scopedLocationIds(ctx);   // string[] | null
if (scoped && userLocationId && !scoped.includes(userLocationId)) {
  throw new InvalidInputError('locationId is outside your branch scope');
}
const whereLocation =
  userLocationId ? { locationId: userLocationId }
  : scoped ? { locationId: { in: scoped } }
  : {};
```

`null` means the caller has org-wide reach (ORG_OWNER, ORG_ADMIN,
FRONT_DESK with empty branch scope). Non-null means "must filter to
these locations". Empty array is intentional — a BRANCH_MANAGER with
zero linked branches sees zero rows.

Currently applied to `/api/appointments` GET and `/api/waitlist` GET.
Analytics + insurance export are left to a future audit — spec §6.2
grants `report.financial:org` to owners only, so BRANCH_MANAGER never
reaches those endpoints and scope-filtering is defensive rather than
required.

### Admin guardrails composition

`updateMemberRole` and `removeMember` layer four checks in order:

1. **Self-mutation refused** — you can't change or remove your own row.
2. **Rank + lattice** via `canManageRoleAssignment(actorCtx, targetKey)`
   — checked against BOTH the new role (in updateMemberRole) AND the
   target's current role. An ORG_ADMIN can't touch an ORG_OWNER.
3. **Last-owner protection** via `assertNotLastOwner` — spec §9 rule 1.
   Runs inside the tx.
4. **Session-version bump** on the target user after a successful
   write — spec §9 rule 10. Their JWT gets rejected within 5s.

The rank check happens BEFORE the tx (buildAuthContext needs its own
connection); the last-owner check + write + session bump run INSIDE
one tx. Any exception aborts the whole thing.

### Ownership transfer flow

Two-step (`lib/admin/ownership-transfer.ts`):

- `nominateTransfer(session, toUserId)` — current owner nominates a
  member. Writes an `ownership_transfers` row (7-day expiry), notifies
  the nominee (in-app + email), bumps the nominee's sessionVersion
  so their client sees the notification within 5s.
- `acceptTransfer(session, transferId)` — nominee accepts. Single tx
  swaps `organizations.owner_user_id`, promotes nominee to ORG_OWNER,
  demotes previous owner to ORG_ADMIN, bumps both sessionVersions,
  writes audit rows for both role changes.
- `declineTransfer(session, transferId, reason)` — nominee declines.
- `revokeTransfer(session, transferId)` — nominator revokes their own
  pending transfer.

Expired rows are handled lazily on `acceptTransfer` — a stale pending
row past `expires_at` is flipped to `status='expired'` and the accept
is refused. A housekeeping cron can also sweep for cleanliness.

### CLIENT-plane (deferred to v3)

Spec §11 v3. No consumer-facing routes exist today. `can()`'s `:own`
scope resolution correctly requires `resource.ownerUserId ===
ctx.userId` — a CLIENT role with only `booking.read:own` cannot pass
a check that doesn't match. Reachable in Phase 6 through the existing
`can()` test coverage.


