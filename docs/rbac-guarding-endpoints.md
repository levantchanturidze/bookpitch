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
