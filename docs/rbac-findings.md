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
