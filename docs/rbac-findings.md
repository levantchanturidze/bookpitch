# RBAC — Post-launch Findings Backlog

Findings surfaced during the production sign-in bootstrap on 2026-07-30.
Not fixed in that session by design — each needs its own review + code
change + tests. Priority markers are the reviewer's initial cut, not
authoritative.

## F-01 · Two dev seed accounts in production · P1 · Security

**What:** Production `app_users` contains two rows created 2026-07-24:
`owner@bookpitch.dev` and `reception@bookpitch.dev`.

**Where they come from:** `prisma/seed.ts` lines 178-187 create these
two users with `passwordHash = await hash(DEV_PASSWORD)` where
`DEV_PASSWORD = process.env.DEV_USER_PASSWORD ?? 'devpass123'` (line 20).
Someone ran `prisma db seed` against production at project setup.

**Risk:** if `DEV_USER_PASSWORD` was unset (likely — it's a dev-only
env var), both accounts have the hard-coded string `devpass123` as
their password. That default lives in the repo — anyone with read
access can sign in.

**What to check first:** query prod, argon2-verify `devpass123` against
each row's `password_hash`. If either matches, revoke immediately
(status='locked' or delete). Even if neither matches, decide whether
these accounts should exist at all in prod.

**Also:** neither account has a platform role, but both hold org
memberships in whatever fixture org the seed created. Confirm those
memberships and the org itself are gone or intended.

## F-02 · `prisma/seed.ts` wipes major tables · P1 · Data-loss risk

**What:** `prisma/seed.ts` lines 62-82 calls `deleteMany()` on
`auditLog`, `messageLog`, `messageTemplate`, `payment`, `appointment`,
`treatmentHistory`, `staffAvailability`, `staff`, `customer`, `service`,
`location`, `membership`, `appUser`, `organization`. Then re-populates
with dev fixtures. Running `npx prisma db seed` against production
would wipe every tenant table.

**Aggravating:** the connection URL is not checked. There is no
"you're pointing at prod, are you sure?" guard. `package.json`
`db:seed` script runs the exact same file.

**Suggested fix:** add a hard-refuse block at the top of `seed.ts`:

```ts
const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error('Refusing to run seed against non-localhost DB: ' + new URL(url).hostname);
}
```

Same guard belongs in `prisma/rbac-fixtures.ts` (creates test users like
`superadmin@bp.test`, `owner@bookpitch.dev`). Only `prisma/rbac-seed.ts`
(reference data — roles, permissions) is safe to run against prod.

Related: the audit log's append-only triggers are DISABLE'd during the
seed's deleteMany (line 62: `ALTER TABLE audit_log DISABLE TRIGGER USER`).
That is correct for the local reset flow but is a second reason no dev
seed should ever hit prod.

## F-03 · `create-platform-user.ts` writes no audit row · P2

**What:** `scripts/create-platform-user.ts` creates or updates an
`app_users` row with a platform role and does not insert into
`audit_log`. The file comment says so explicitly ("Only writes to
app_users").

**Why it matters:** every subsequent platform action by that account
is audited, but the account's own existence is not. The bootstrap
SUPER_ADMIN's creation is a legally interesting event — first key to
the kingdom — and it leaves no trail.

**Suggested shape:** the script inserts one `audit_log` row
`(actor_user_id=NULL, action='platform_user.create' or 'platform_user.update',
entity='staff', entity_id=<newUser.id>, meta={'via':'create-platform-user.ts',
'hostname':<...>, 'invoked_by':process.env.USER})`. Actor is NULL
because there's no logged-in caller at bootstrap time; the meta captures
the operator context instead.

## F-04 · `/platform` access-control layer · P2 · Security review

**What:** need to confirm which layer actually gates `/platform/*`
against a caller who has an `app_users` row + a JWT but NOT a platform
role — for example, a FRONT_DESK who tries `curl /platform/orgs` with
their session cookie.

**Suspect state:** `app/platform/layout.tsx` calls `requireAuthContext()`
which just requires a signed-in user. There is no `if
(!ctx.platformPermissions.size)` check at the layout level. If enforcement
lives only inside individual API routes via `requirePermission`, then
the layout will render (leaking UI structure) even if the caller has no
platform permission — and any bug where the client-side navigation calls
data-fetching endpoints without proper checks becomes a data leak.

**Test to write:**
`tests/platform-access-control.test.ts` that mocks a FRONT_DESK JWT
+ hits every `/platform/*` page component and every `/api/platform/*`
route, asserts either 403 or a redirect. Should have been part of
Phase 5.

## F-05 · Test blind spot: mocked auth everywhere · P2 · Coverage

**What:** the entire test suite mocks `@/auth` (or the JWT / session /
AuthContext directly). No test exercises the real credentials `authorize()`
flow end-to-end. Phase 5 shipped green with a completely broken
platform-user sign-in path (the `memberships.length === 0` bug
covered by every Phase 5 test — because every test bypasses authorize()).

**Files that mock instead of using the real path:**
- `tests/helpers/session.ts` — `mockJwt`, `mockPlatformJwt` helpers used
  by every route/access test.
- Every `tests/platform-*.test.ts` uses `mockPlatformJwt(...)`.
- `tests/route-access.test.ts:86` hard-codes `platformRoleId: null`.
- `tests/security-review.test.ts:690` explicitly notes: `NextAuth's
  authorize is not directly invokable from tests without ...` and skips
  the check.

**Suggested fix:** one integration test that hits `/api/auth/csrf` +
`/api/auth/callback/credentials` against a local Next.js dev server
with a seeded user, verifies a `session-token` cookie is issued, and
uses that cookie to `GET /platform/orgs`. This is the only shape that
would have caught the authorize() bug.

## F-08 · Platform §6.1 gaps still open · P2 · Feature completeness

**Fixed 2026-08-02 (commit 81fd1ea):**
- Organization creation — POST /api/platform/orgs + /platform/orgs/new page.
- Platform role assignment (SUPER_ADMIN only) — POST /api/platform/roles +
  /platform/roles page.

**Still missing from spec §6.1:**
- **Edit organization.** No PATCH /api/platform/orgs/[id] and no edit UI.
  Only name/vertical/allowSupportImpersonation would be editable today.
  Low-effort; do this alongside the toggle UI below.
- **Feature flags / global config CRUD.** `organizations.features` (JSONB)
  exists and has consumers (spec §6.2 toggle keys), but there's no endpoint
  that lets SUPER_ADMIN read/write it from /platform. Related:
  `organizations.allowSupportImpersonation` is read on the API side but
  no UI toggles it.
- **Subscription / plan / invoice management.** `platform.billing.*` perms
  are seeded (SUPER_ADMIN + PLATFORM_ADMIN can manage; SUPPORT_AGENT read),
  and `organizations.plan`, `planStatus`, `stripe*` columns exist — but no
  endpoints or UI wire them together. Stripe integration is scaffolded in
  `lib/billing/` but not connected to /platform.
- **Audit-log filters in the UI.** GET /api/platform/audit supports query
  params but the /platform/audit page renders all rows with no filter form.
- **Organization status dashboard.** Aggregate view (member count, last
  activity, trial expiry) — some columns are already populated on the
  `_count` side; UI could aggregate them without new endpoints.

## F-09 · `:own` scope on list-mode calls returns false · P1 · Enforcement design gap

**What:** `lib/rbac/can.ts:107-110` — when a caller with `:own` scope
hits a list endpoint (no specific `resource.ownerUserId`),
`can(ctx, 'booking.read')` returns false. `:branch` scope has a
list-mode fallback (line 103: `if (!resource?.branchId) return true`)
that grants the call and expects the query to filter by the caller's
branch. `:own` has no equivalent, so a PROVIDER with `booking.read:own`
literally cannot list their own calendar under enforcement mode.

**Confirmed 2026-08-02:** flipped `RBAC_ENFORCE_MODULES=*` on prod.
PROVIDER sign-in landed at `/scheduler` which returned 500 because
`GET /api/appointments` calls
`requirePermission(ctx, 'booking.read', {organizationId}, 'appointments')`.
Log line: `rbac.enforce_deny permission=booking.read roleKey=PROVIDER`.
Same failure for ACCOUNTANT and anyone with `:own`-scoped read
permissions on list endpoints.

**Reverted the enforcement flip** to keep prod usable while this is
fixed. Shadow mode logs the deny but serves the request.

**Fix path (needs a code change, not a config flip):**
1. `lib/rbac/can.ts` — add a list-mode grant for `:own` mirroring the
   `:branch` pattern:
   ```ts
   if (granted.has(perm(`${p}:own`))) {
     if (!resource?.ownerUserId) return true;
     return resource.ownerUserId === ctx.userId;
   }
   ```
2. Every list route that calls `requirePermission(_, 'X.read', …)`
   with `X:own` in scope must ALSO filter its query to `ownerUserId
   === ctx.userId` — otherwise the `:own` scope grants a full list
   read. Same trust model as `:branch`: guard is permissive at the
   permission layer, the query layer is responsible for scope
   containment.
3. New helper `scopedByOwn(ctx, 'X.read')` → returns `ctx.userId` if
   the caller's strongest matching scope is `:own`, else null. Routes
   consume it in their `WHERE` clauses.

**Blast radius:** every list endpoint with `:own` scope in play
(`/api/appointments`, likely `/api/customers` if PROVIDER has
`client.read:own`, calendar surfaces). The fix requires per-route
audit + queries updated.

**Related discovered 2026-08-02:** Supabase free-tier session-mode
pooler is capped at 15 clients. My probe spike (7 accounts × parallel
sign-ins) exhausted it and caused ~10 minutes of production 500s. The
prisma clients in `lib/db.ts` open a connection per query without a
tight upper bound. Consider (a) moving `prismaAdmin` reads through
the transaction-mode pooler where possible, or (b) upgrading Supabase
tier.

## F-07 · RBAC guards ship in SHADOW MODE in production · P0 · Security

**What:** `lib/rbac/guard.ts::requirePermission` calls `isEnforcing(module)`,
which returns `false` unless `RBAC_ENFORCE_MODULES` env var is set. In shadow
mode the guard logs `rbac.shadow_deny` and returns the ctx unchanged — the
caller's route handler runs anyway. **No permission check actually blocks a
request in production today.**

**Confirmed live:** FRONT_DESK test account got 200 (not 403) from
`GET /api/admin/staff` on `bookpitch1.vercel.app`. The endpoint requires
`staff.update` which FRONT_DESK does not have (verified in `role_permissions`).
Vercel runtime log for that request:

```
{"level":"warn","msg":"rbac.shadow_deny","permission":"staff.update",
 "module":"admin","roleKey":"FRONT_DESK",...}
```

Denial logged, request served.

**Env-var check:** `vercel env ls production` shows no `RBAC_ENFORCE_MODULES`
key exists. So every module is in shadow.

**Impact:** every permission check in the app is a no-op right now. FRONT_DESK
can read staff endpoints, ORG_ADMIN can attempt actions above their rank,
PROVIDER can hit other providers' bookings — none of it is enforced. The only
things preventing full data leakage today are: (a) RLS on tenant-scoped tables
(still working, verified with Phase 5 tests), (b) route handlers that shape
their queries defensively (variable), and (c) branch-scope check which fires
BEFORE `requirePermission` in `app/api/appointments/route.ts` (still enforcing
per probe 3, unrelated to `requirePermission`).

**Fix path:** set `RBAC_ENFORCE_MODULES` in Vercel Preview + Production. The
Phase 4 enforcement audit (`docs/rbac-enforcement-audit.md`) lists every
module — start with `*` (enforce all) for prod, or roll module-by-module
starting with `admin`, `platform`, `payments`. Test every core flow first;
enforcement mode will surface any missed `requirePermission` call or wrong
permission key as a 403.

**Do not blindly flip `*` in prod without first running the app against a
staging DB with `RBAC_ENFORCE_MODULES=*` for at least a session per role.**
The Phase 4 tests are all mocked — actual enforcement outcomes may differ.

## F-06 · Vercel build runs no migration step · P1 · Deploy pipeline

**What:** `package.json` `build` is `next build`. There is no
`prisma migrate deploy` in the pipeline. Any push that adds a
migration deploys application code that expects the new schema, but the
schema stays on the prior version — which is exactly what happened
2026-07-29 (12 unapplied migrations, sign-in broken until manually
migrated 2026-07-30).

**Options and their trade-offs:**

1. **Prepend migrate to build.** `"build": "prisma migrate deploy && next build"`.
   Simplest. Downsides: every preview deploy runs migrations too — Vercel
   Preview needs its own DB or gets side effects. And concurrent deploys
   (e.g. two branches pushed within seconds) race on the same DB — Prisma
   uses an advisory lock that mostly handles this, but the lock is
   session-scoped and pooler-quirks are real.

2. **CI-runner step, separate from Vercel.** GitHub Actions runs
   `prisma migrate deploy` on push to `main` before Vercel deploys. Safer
   (single actor, ordered, can gate on manual approval), but Vercel might
   deploy before the migration finishes — need a workflow that either
   blocks on the migrate step or a Vercel deploy hook.

3. **Manual migration + tagged releases.** Migrations become a deliberate
   ops action. Best for a paranoid rollout. Loses the "commits ship
   automatically" property.

4. **Prisma Data Platform's release automation** or Supabase's own
   migration CLI — third-party glue.

**Recommendation:** option 2 with a `deploy-migrations.yml` workflow
that runs on push-to-main, uses `ADMIN_DATABASE_URL` from GH Actions
secrets, and requires the workflow to succeed before Vercel's git
integration is allowed to promote. Concurrent branch pushes are
naturally serialized by GH Actions.

**Also:** whatever is chosen, add a `prisma migrate status` post-deploy
check (a route or a scheduled probe) that fails loudly if the runtime
schema doesn't match the built-in migration set. Silent drift is the
underlying failure mode.
