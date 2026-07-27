# Bookpitch RBAC — Phase 0 Discovery

**Author:** Claude (Phase 0 read-only audit)
**Date:** 2026-07-27
**Branch investigated:** `rbac-rebuild`
**Working commit:** `408f6cb docs: RBAC spec and implementation plan`
**Scope:** what exists today, measured against `docs/rbac-spec.md`. No code
changed. Numbers were pulled from the local dev DB
(`postgresql://levan@localhost:5432/bookpitch_dev`). Confidence levels are
called out per finding; "High" means I read it directly, "Medium" means it
was inferred from an adjacent artifact, "Low" means I could not verify from
this environment and it needs an answer before Phase 1.

---

## 1. Stack

| Layer | Value | Confidence |
|---|---|---|
| Framework | Next.js **16.2.11**, App Router | High — `package.json` |
| React | 19.2.4 | High |
| Runtime | Node.js — Next 16's Proxy (`proxy.ts`) runs on Node, not Edge. `middleware.ts` was renamed to `proxy.ts` per Next 16 breaking change (see commit `1308614`). | High |
| Server-side code | **Route handlers** under `app/api/*` and **server components** under `app/(app)/*`. No tRPC, no separate API service. | High |
| ORM | Prisma **7.9.0** with the `@prisma/adapter-pg` driver adapter (native `pg` under the hood). Client generated to `@prisma/client`. | High |
| Migration tooling | `prisma migrate` (`db:migrate` / `db:migrate:dev` in `package.json`). 19 migrations exist under `prisma/migrations`. | High |
| Database | **PostgreSQL 16.14** (Homebrew Postgres locally). Extensions in use: `pgcrypto`, `btree_gist`, `citext`. | High |
| RLS-friendliness | **Postgres is confirmed** — the spec's §10 second layer (RLS on `organization_id`) is available and already partially wired. See §5 below. | High |
| Hosting | **Vercel**, region `fra1` (`vercel.json`). Prisma production DB is a hosted EU-region Postgres per `ARCHITECTURE.md` §2 (Neon/Supabase-class). Local Docker Postgres (`docker-compose.yml`) is throwaway only. | High for Vercel; **Medium for exact DB provider** — `.env.local` points at local Postgres; `.env.supabase` exists but was not read. See open questions. |
| Cutover / maintenance window | **Unknown.** No downtime policy is documented. **This is a Phase 2 blocker** — the migration shape (§7) is very different depending on the answer. See open questions #1. | **Low** |
| Auth library | Auth.js v5 (**next-auth 5.0.0-beta.32**) + `@auth/prisma-adapter`, `Credentials` provider, argon2 password hashing (`@node-rs/argon2`). | High |
| Test framework | Vitest 4.1.10 (unit + integration, hits a real DB), Playwright 1.61.1 (one e2e spec). See §6. | High |
| Observability | Sentry (client/server/edge configs present), custom `lib/logger.ts` with request-scoped context. | High |
| Feature flags | JSONB on `organizations.features` (per-org), managed via `lib/features.ts`. Not a global-flag system. | High |
| Billing | Stripe (subscription plan/status on `organizations`); local payment gateway is BoG/TBC-shaped (see `lib/payments/`). Not directly relevant to RBAC but relevant to the "ORG_OWNER controls billing" invariant. | High |

---

## 2. Auth

### 2.1. Session model

- **JWT sessions** — `session: { strategy: 'jwt' }` in `auth.config.ts:13`.
  Encrypted JWT lives in the `authjs.session-token` cookie (or the `__Secure-`
  prefix in production, per Auth.js defaults). **No server-side session table
  is queried per request** — the JWT is self-contained.
- **JWT payload shape** (see `auth.ts:24-32`):
  ```ts
  {
    userId: string,
    email: string,
    organizationId: string,   // ← chosen at login, first membership
    role: 'owner' | 'practitioner' | 'receptionist',
    sessionVersion: number,   // for revocation
  }
  ```
- **Effective session shape** returned to server code (`auth.ts:14-22` +
  `lib/auth.ts:6-11`):
  ```ts
  type ActiveSession = {
    userId: string;
    organizationId: string;
    role: UserRole;
    email: string;
  };
  ```
- **Multi-org today, sort of.** The JWT still carries the login-time
  `organizationId + role`, but `lib/org-switch.ts::resolveActiveOrg`
  transparently rewrites it based on a `bp_active_org` cookie when that
  cookie names a valid membership (looked up via `withoutRls`). So the
  request-scoped `ActiveSession.role` can differ from the JWT's role. This
  is the current multi-tenant switcher — **it exists, but only three roles
  exist to switch between.** See `app/api/session/switch/route.ts`.
- **Session-version revocation.** `AppUser.sessionVersion` is bumped on
  password reset (`lib/auth/password-reset.ts:114`). The
  `session()` callback (`auth.ts:121-135`) refuses any JWT whose
  `sessionVersion` no longer matches the DB, with a 5s in-process cache
  (`SV_TTL_MS`). This is our only invalidation lever today.

### 2.2. Path from cookie to `session.user`

1. Browser sends `authjs.session-token` cookie on every request.
2. Next 16's `proxy.ts` runs `NextAuth(authConfig).auth` — decrypts the JWT,
   calls the `authorized({ auth, request })` callback in `auth.config.ts:19`,
   redirects to `/signin` if the path isn't public and the JWT is absent.
3. Inside route handlers / server components, `getSession()`
   (`lib/auth.ts:19`) calls `auth()` from `auth.ts:51`. That does NOT
   re-check the DB; it decrypts the JWT, runs the `jwt`/`session` callbacks,
   and returns a `Session`. The `session()` callback DOES check the DB —
   `getCurrentSessionVersion(userId)` — to enforce revocation.
4. `getSession()` then calls `resolveActiveOrg()` which reads the
   `bp_active_org` cookie and, if present + valid, swaps in the
   membership's org/role for this request.
5. `requireRole(...roles)` (`lib/auth.ts:84`) simply checks
   `roles.includes(session.role)` and throws `ForbiddenError` otherwise.

### 2.3. Active sessions

- **Cannot be counted directly.** JWT sessions are stateless — there is no
  `sessions` table to query. We can bound it below by (a) `AppUser` count and
  (b) any short-window auth-related audit-log activity.
- Cutover options: force re-login by bumping `sessionVersion` for every
  user in a single UPDATE (already the mechanism the reset flow uses per
  user; it's proven at N=1). This flushes every live JWT within ~5s.
- **Cost of forcing re-login is low today** because there are effectively
  no live users (see §4). Even if production has more, the cutover cost is
  "everyone re-authenticates once" — no bespoke JWT compatibility layer is
  required.

Confidence on §2: **High** for shape and flow, **Medium** for production
session volume.

---

## 3. Current authorization

### 3.1. Role model

Enum, hard-coded in the database and Prisma schema:

```sql
CREATE TYPE user_role AS ENUM ('owner', 'practitioner', 'receptionist');
```

Attached to `memberships (user_id, organization_id, role)` — the good news
is the spec's "membership pattern" is **already the physical model**. The
row-shape is spec-compliant; only the role vocabulary and the missing
columns (see §5) need to change.

Unique constraint: `UNIQUE (organization_id, user_id)` — **there can only
be one role per user per org today.** The spec's `UNIQUE (user_id, organization_id, role_id)`
is a strict superset, so this is additive.

### 3.2. Where roles are checked (High confidence)

- **Single funnel:** `requireRole(...UserRole[])` in `lib/auth.ts:84`.
  Called from:
  - **41 route handler files** (grep: `grep -c requireRole app/api -r` sums
    to ~85 individual `requireRole(...)` invocations across 41 files);
  - **13 server-page files** in `app/(app)/`;
  - Two direct `session.role === 'owner'` checks used for UI branching:
    `app/(app)/patients/page.tsx:31`, `app/(app)/reminders/page.tsx:98`;
  - Two direct string comparisons in service code: `lib/invitations.ts:40 & 177`,
    `lib/billing/service.ts:47`.
- **`NAV_ITEMS` (`components/shell/nav-items.ts`)** is a single source of
  truth for allowed roles per nav entry and is verified against page-level
  `requireRole` calls by `tests/route-access.test.ts`.
- **No permission strings anywhere.** The whole codebase reasons in "roles"
  (three of them), not permissions. There is no `can(user, 'booking.read:org')`
  primitive.
- **No `permission_key` table.** Permissions are entirely implicit in the
  role-name → allowed-endpoints mapping baked into route handlers.

### 3.3. Tenant scoping (High confidence)

- Two-layer isolation, and **it's real**, not aspirational:
  - **App layer:** `withOrg(orgId, fn)` (`lib/db.ts:68`) opens a Prisma tx,
    runs `SET LOCAL app.current_org_id = '<uuid>'`, and executes `fn(tx)`.
    Callers pass `session.organizationId` from the resolved session — never
    from user input.
  - **DB layer:** `20260722000002_add_rls` enables `FORCE ROW LEVEL
    SECURITY` on 16 tenant tables + audit_log with a `tenant_isolation`
    policy keyed on `current_org_id()`.
- **A NON-superuser role, `bookpitch_app`, is created** by
  `20260722000003_create_app_role`. `DATABASE_URL` connects as this role;
  `ADMIN_DATABASE_URL` connects as the OS superuser for migrations, seed,
  and RLS-bypass paths (`prismaAdmin`).
- **Fail-closed proof by test:** `tests/rls.test.ts:44-52` demonstrates that
  `prismaApp.customer.findMany()` with no `app.current_org_id` set returns
  zero rows — the policy predicate evaluates NULL. Good.
- **`withoutRls` is used deliberately** for: login lookup, onboarding
  (org doesn't exist yet), org switching, invitation acceptance (user has no
  session yet), password reset, push subscription table, audit-digest cron,
  retention cron, feature-flag reads, housekeeping cron. Every usage I read
  had a plausible justification. **This does not mean there are no
  cross-tenant bugs in those paths** — RLS is off there by construction —
  but there's no obvious misuse.
- **Two tables are conspicuously RLS-free**: `push_subscription` (per-user,
  no `organization_id` column) and `verification_tokens` (auth adapter
  table). Both are defensible — `push_subscription` is keyed on `user_id`
  and only ever read via `withoutRls`; `verification_tokens` predate any
  session. These are worth noting for the security review in Phase 7 but
  don't block anything.

### 3.4. Audit log

- Table exists (`audit_log`), is partitioned monthly by `at` (nice for
  retention), and is written via `writeAudit()` (`lib/audit.ts:16`) inside
  the caller's `withOrg` tx.
- **INVARIANT VIOLATION vs spec §6.1 + §9 rule 11**:
  `20260723000008_audit_partition/migration.sql:134` grants **INSERT,
  UPDATE, DELETE** on `audit_log` to `bookpitch_app`. The spec says
  UPDATE/DELETE must be impossible at the DB level, even for SUPER_ADMIN.
  **Rank #1 finding in the risk list.**
- **Field shape mismatch vs spec §7.1**: the spec's `audit_logs` row
  includes `on_behalf_of_user_id`, `resource_type`, `resource_id`,
  `user_agent`, `reason`, `impersonation_session_id`,
  `break_glass_session_id`. Today's `audit_log` has:
  `organization_id, actor_user_id, action, entity, entity_id, at, ip, meta`.
  Additive migration required (Phase 1). `entity`/`entity_id` map to
  `resource_type`/`resource_id`; `meta` can hold `user_agent`/`reason`
  transitionally.

Confidence on §3: **High.**

---

## 4. Data reality (dev DB — Postgres 16 local)

| Table | Rows |
|---|---:|
| `organizations` | 2 |
| `app_users` | 3 |
| `memberships` | 3 |
| `staff` | 5 |
| `locations` | 3 |
| `customers` | 6 |
| `appointments` | 7 |
| `invitations` | 0 |
| `audit_log` | 1,798 |

Role distribution (`memberships`): `owner: 2`, `receptionist: 1`,
`practitioner: 0`.

Per-org membership counts:
- `Grand Medical & Aurora Spa Group` — 2 members (1 owner, 1 receptionist).
- `Isolation Corp` — 1 member (owner; exists to prove RLS).

Data-quality checks (all clean):
- Duplicate emails in `app_users`: **0**.
- Orphaned memberships (user missing): **0**.
- Orphaned staff (org missing): **0**.
- Orgs with **no active owner** (spec §9 rule 1 pre-check): **0**.
- Users belonging to more than one org: **0**.

**Interpretation.** This is a seeded dev database, not production. The
numbers are useful in one direction only: **there is no data-shape crisis
in dev**. The whole `memberships` table is 3 rows — Phase 2 on this
database is trivial. **Production numbers are unknown from this
environment.** The migration difficulty is bounded by whatever's in the
hosted EU-region DB, which I could not query. See open question #2.

Notably absent columns in current schema that the spec's Phase-2 will need
to backfill or add (all additive):
- `app_users.status` (`active|locked|deleted`) — not present. Only
  `email_verified` exists.
- `app_users.locale`, `mfa_enabled`, `last_login_at` — not present.
- `app_users.platform_role_id` — not present (no platform-plane concept yet).
- `organizations.status`, `.vertical`, `.brand_name`, `.legal_name`,
  `.subscription_plan`, `.owner_user_id`, `.allow_support_impersonation` —
  none exist. Today's `organizations` has `plan`, `planStatus`,
  `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`,
  `features(jsonb)`, `reminderLeadHours`, `customerRetentionYears`,
  `createdAt`, `updatedAt`. `plan/planStatus` are close to
  `subscription_plan/status` but not spec-shaped.
- `memberships` has `role UserRole` (enum) — the spec wants `role_id`
  → `roles` table. Also missing: `status`, `is_bookable`,
  `invited_by_user_id`, `joined_at`, and the multi-role uniqueness
  (`UNIQUE (user_id, organization_id, role_id)`).
- `membership_branches` — does not exist. Would need `branches` first;
  today the concept is `locations`, which is location-typed
  (`clinic|salon`), NOT quite the same as spec's `branches`. See §5.
- `roles` and `permissions` tables — do not exist. Nothing about
  permissions lives in the DB today.

Confidence on §4: **High for dev**, **Low for production**.

---

## 5. Gap analysis — spec §3 (data model) and §4 (roles) vs today

### 5.1. Data model gaps

| Spec table / column | Today | Verdict |
|---|---|---|
| `users.platform_role_id` | Absent | Add (Phase 1) |
| `users.status`, `locale`, `mfa_enabled`, `last_login_at` | Absent | Add |
| `organizations.vertical`, `.status`, `.legal_name`, `.brand_name`, `.owner_user_id`, `.allow_support_impersonation` | Absent (only `name`, `plan*`, features/JSONB) | Add |
| `branches` | Not present as its own table. Today's `locations` fills part of the role but carries `type: 'clinic'|'salon'` which is a vertical marker, not a branching concept. | **Decision needed** (open question #3): promote `locations` → `branches`, or add `branches` as new? |
| `memberships (role_id, status, is_bookable, invited_by_user_id, joined_at)` | Only `(role: UserRole, createdAt)`. Uniqueness is `(org, user)` not `(org, user, role_id)`. | Additive migration + data backfill |
| `membership_branches` | Absent | New table (Phase 1) |
| `roles(id, key, display_name, plane, rank, organization_id, is_system)` | Absent (roles = enum values) | New table (Phase 1) |
| `permissions(key, resource, action, scope, description)` | Absent | New table (Phase 1) |
| `role_permissions(role_id, permission_key)` | Absent | New table (Phase 1) |
| `audit_logs` (superset shape) | Subset today. See §3.4. | Additive migration + append-only enforcement (Phase 1) |

### 5.2. Role gaps (spec §4 vs today)

| Spec role | Today | Migration story |
|---|---|---|
| `SUPER_ADMIN` | — | New. Nobody today can act cross-org except by direct DB access. |
| `PLATFORM_ADMIN` | — | New. |
| `SUPPORT_AGENT` | — | New. |
| `BILLING_MANAGER` (optional) | — | Defer to v3 per spec §11. |
| `ORG_OWNER` | `owner` | Rename; ~2 rows in dev, unknown in prod. |
| `ORG_ADMIN` | — | New. **Must be created before splitting today's `owner`** (spec §2.1). |
| `BRANCH_MANAGER` | — | Spec §11 places in v2. |
| `FRONT_DESK` | `receptionist` | Rename. |
| `PROVIDER` | `practitioner` | Rename. |
| `SENIOR_PROVIDER`, `ACCOUNTANT`, `MARKETING` | — | Defer to v2. |
| `CLIENT` | — | Deferred to v3 in spec §11; consumer plane is out of MVP. |

The rename set (`owner → ORG_OWNER`, `practitioner → PROVIDER`,
`receptionist → FRONT_DESK`) is a Phase-2 backfill: insert the new `roles`
rows, then flip `memberships.role_id` to point at them, then drop the enum.
On the dev DB this is 3 UPDATEs.

### 5.3. Enforcement gaps

- No `can(ctx, permission, resource)` function anywhere. Spec §10 requires
  it, and it needs to exist before Phase 4 can start swapping `requireRole`
  callsites over.
- No scope keywords (`:own | :branch | :org | :platform`). Today's checks
  are role-membership tests, so there's no code equivalent of
  `booking.read:branch`.
- No permissions cache (spec §10 mentions Redis; today there's no Redis
  anywhere and no `permissions_version` in the JWT).
- No `RESTRICTED_DURING_IMPERSONATION` set — no impersonation yet.
- No break-glass flow (spec §7.2). No such UI, no such audit-log flags.
- No "≥1 active `ORG_OWNER`" enforcement — invariant #1 in spec §9. Today's
  `admin.ts::updateMemberRole` only refuses "you cannot change your own
  role" (`lib/admin.ts:464`); it will happily demote the sole owner as long
  as an admin does it. Similarly `removeMember` (`admin.ts:473`) only stops
  self-removal.
- No "no privilege escalation" rule — `admin.ts::updateMemberRole` accepts
  any `UserRole` value regardless of caller rank. Today this only matters
  because `owner` is the only role that can call the endpoint (the
  `requireRole('owner')` at the route layer, `app/api/admin/members/[id]/route.ts:8`),
  but the pattern doesn't survive a fifth role.
- No password-set-by-admin guard — but `admin.ts::inviteMember` **does set
  a password directly** (`admin.ts:405, 421`). This violates spec §9 rule
  4 ("admins never set passwords, only reset links"). The newer
  `lib/invitations.ts` flow uses tokens correctly. **The two flows coexist
  today.** See risk #4.

Confidence on §5: **High.**

---

## 6. Testing

- **Framework:** Vitest 4.1.10, node environment, `fileParallelism: false`
  (serial — shared DB state).
- **Setup:** `tests/setup.ts` loads `.env.local`. Tests hit the **real**
  local Postgres — they are integration tests, not mocked-DB unit tests.
- **Test count:** 37 test files under `tests/`. Coverage is broad and
  includes:
  - `rls.test.ts` — proves tenant isolation with a two-org fixture.
  - `rbac.test.ts` — verifies `requireRole` throws Unauthenticated/Forbidden
    correctly and hits the `whoami-owner` route as a sample.
  - `route-access.test.ts` — parameterized over `NAV_ITEMS.allowedRoles` ×
    5 pages × 3 roles + anonymous. This is the closest thing to a test
    matrix.
  - Feature-level tests: `appointments-api`, `admin`, `analytics`,
    `audit-*`, `billing`, `customers-api`, `gdpr`, `insurance`,
    `invitations`, `notifications`, `onboarding`, `org-switch`,
    `password-reset`, `payments-*`, `public-booking`, `push`,
    `rate-limit`, `reminders`, `waitlist`.
- **Seeded fixtures:** `prisma/seed.ts` builds **two orgs** — `Grand
  Medical & Aurora Spa Group` (2 users) and `Isolation Corp` (1 user, 1
  customer named "Do Not Leak"). Multi-tenant fixtures **exist** — this is
  what makes `rls.test.ts` real. However, **no test today exercises a
  single user with memberships in both orgs** — that shape is spec-critical
  (§2.3) but not represented in fixtures.
- **e2e:** one Playwright spec (`e2e/signup-scheduler.spec.ts`). Not
  role-oriented.
- **How to run:** `npm test` (vitest run), `npm run test:watch`, `npm run e2e`.

Gaps to expect:
- Fixture needs a "solo practitioner" user (spec §2.3 scenario 2 — same
  person, `ORG_OWNER` **and** `PROVIDER` in one org).
- Fixture needs a "moonlighting practitioner" (same user, `PROVIDER` in two
  orgs) to exercise membership uniqueness and org-switch correctness.
- Fixture needs a branch-scoped user (spec §4.2 `BRANCH_MANAGER`) — blocked
  on the `branches` decision (open #3).
- Every `requireRole` swap in Phase 4 needs a paired `can()` test; the
  route-access test's shape is a good template.

Confidence on §6: **High** for what exists; **High** for the fixture gaps
because I read the seed file end-to-end.

---

## 7. Ranked risk list

Ordered by "how likely is this to bite us, and how much cleanup does it
cause." Numbers are for context, not scores.

### R1 — `audit_log` is not append-only (blocks spec invariant §9.11)
`20260723000008_audit_partition/migration.sql:134` grants UPDATE + DELETE
on `audit_log` to `bookpitch_app`. Anyone with the app's credentials can
rewrite history. This is one migration to fix (`REVOKE UPDATE, DELETE ...`
+ a policy or trigger for defense in depth), so cost is low, but it is a
literal invariant violation *right now* and shipping any spec-branded
system with this in place would be reputationally bad. **Fix in Phase 1
alongside the schema additions, not later.**

### R2 — `bp_active_org` cookie + JWT `role` drift
`resolveActiveOrg` (`lib/org-switch.ts:70`) silently replaces JWT-provided
`{organizationId, role}` with cookie-derived values after a DB check. This
is convenient today (three roles, low stakes) but combines badly with the
spec's permission cache (§10 mentions `permissions_version` in the token).
Once permissions live in the token, a stale cookie or a revoked membership
inside a live JWT window becomes a real permission-lag bug. **Design
decision needed before Phase 3:** either move the active org to a
server-checked value on every request (already happens for JWT
validation; adding an org check is one join), or invalidate the cookie
when the membership is removed. Do not carry the cookie pattern into the
new world unchanged.

### R3 — No enforcement of "≥1 active ORG_OWNER"
`admin.ts::updateMemberRole` and `admin.ts::removeMember` refuse
self-removal only. In dev this can already produce an ownerless org (org
becomes unreachable and the platform has no way to recover without direct
DB writes). Cost is a few lines in `admin.ts` + a DB trigger for defense
in depth. Should be tackled in Phase 1 with the schema work — the check
becomes easier once `memberships.status` exists.

### R4 — Two invitation flows in parallel, one violates rule "admins never
set passwords"
`lib/admin.ts::inviteMember` accepts a `tempPassword`, hashes it with
argon2, creates the user, and writes an audit row. `lib/invitations.ts`
(newer) does the correct thing: emit a hashed token, deliver a link, let
the invitee choose their own password. Both flows are wired to routes.
**Remove `admin.ts::inviteMember` in Phase 4** — but flag it now because
it's the kind of thing that gets missed in a rename pass.

### R5 — RLS is off on `audit_log` partitions (parent has it, children
don't)
Per `pg_class`, the parent `audit_log` has
`relrowsecurity=t, relforcerowsecurity=t`, but every monthly partition
(`audit_log_2026_01` … `audit_log_default`) shows `f/f`. In Postgres, the
parent's RLS applies to queries routed via the parent — but a query that
addresses a partition directly (e.g., a maintenance script) bypasses it.
Today no application code addresses partitions directly, but the
housekeeping cron does. Worth verifying before Phase 5 platform-plane work
(where cross-org reads become intentional and mistakes become worse).

### R6 — 20 `withoutRls` / `prismaAdmin` callsites
Each is deliberate today, but each is also a candidate for a cross-tenant
bug during the rename pass in Phase 4. Concentrate them behind narrower
primitives (`withAppUserLookup`, `withOrgProvisioning`, `withPublicToken`)
before Phase 4 so future callers can't reach for the raw admin client.

### R7 — Permission model must be schema-driven, but 41 files hard-code role
names
Spec §3 "permissions live in the database" implies every callsite must
switch from `requireRole('owner', 'practitioner', 'receptionist')` to
`requirePermission('booking.read:branch')`. That's ~85 individual call
mutations across 41 files, most trivial but a real code churn. Do NOT
attempt to do this in one PR — feature-flag it and phase per module.

### R8 — No production data-reality picture
The dev DB has 3 users. Production numbers are the actual difficulty
signal for Phase 2. Until they're known, Phase 2 sizing is a guess. See
open questions.

### R9 — Vercel Node runtime + Auth.js JWT bundle size
The proxy already avoids the heavy `authorize()` path (that's why
`auth.config.ts` is a slim subset), but if we add
`can()` + a Redis client into the proxy path, we'll re-bloat it.
Permission checks must NOT run in the proxy — enforce in route handlers
only, the proxy stays cookie-presence-only.

### R10 — Timezone of session claims
`ActiveSession.email` is used as `authSubject`. If a user changes their
email one day (not currently possible in code, but foreseeable), the
`(auth_provider, auth_subject)` unique index will silently break. Not a
Phase 1 problem, but worth flagging so spec §3 additions don't lock it in.

---

## 8. Revised phase plan

The spec-prompts file proposes: 0 discovery → 1 schema+seeds → 2 data
migration → 3 auth core → 4 enforcement → 5 platform → 6 org → 7
adversarial security review. I would follow that order **with three
adjustments**:

### 8.1. Roll R1 into Phase 1 (append-only audit_log)
Fixing the UPDATE/DELETE grant is a one-line migration + a "no more
grants like this" test. It doesn't depend on any other Phase 1 work. It
should ship the moment Phase 1 lands so the invariant isn't "aspirational
until Phase 7." Same for R3 (`≥1 owner` guard) — cheap and blocks worse
mistakes.

### 8.2. Insert a "Phase 1.5 — audit callsites" step before Phase 2
Before we run the actual `owner → ORG_OWNER` backfill, catalogue every
place that reads `session.role` **including the two direct string
comparisons in `patients/page.tsx` and `reminders/page.tsx`**. Currently
they're invisible to `requireRole`-based greps. If Phase 4 misses them,
we ship UI branches that always evaluate false ("does role equal literal
`'owner'`?" after we've renamed it to `'ORG_OWNER'`).

### 8.3. Do R2 (cookie-vs-JWT-role drift) in Phase 3, not later
The `bp_active_org` cookie is our current multi-org switcher. Any Phase 3
`can()` design needs to answer "where does the caller's active org come
from and how fresh is it?" — punting this to Phase 6 means the
authorization core ships with a known freshness bug baked in.

Order is otherwise sensible for this codebase because:
- Schema before migration keeps rollbacks tractable (spec §CLAUDE.md rule
  "every migration is reversible").
- Migration before enforcement is safe: today's `requireRole('owner')`
  keeps working during Phase 2 because we backfill role rows that map
  1:1 to the enum values.
- Enforcement before platform-plane is right because the platform plane
  needs `can()` more than the org plane does (that's where the "no
  ceiling for SUPER_ADMIN" logic lives).
- Adversarial review at the end matches the spec's §7 (break-glass) and
  §9 (invariants) emphasis on defense-in-depth.

### 8.4. What the spec-prompts file gets right, that this codebase makes easier
- **The `memberships` table already exists.** Phase 2 does not need to
  physically restructure the table — only add columns and swap `role`
  (enum) for `role_id` (FK). That's the cheapest possible variant of the
  spec's "membership pattern" migration.
- **Postgres + RLS + non-superuser role are already wired.** Phase 3 does
  not need to bring up the tenant-isolation infrastructure; it inherits
  it. Spec §10's second layer is already the codebase's second layer.
- **Audit log partitioning + retention are already solved** (subject to
  R1). The only Phase 1 change is column shape + revoking UPDATE/DELETE.

---

## 9. Open questions — MUST be answered before Phase 1 starts

1. **What is the cutover / downtime tolerance in production?**
   Zero-downtime, off-hours maintenance window, or "we can take the app
   down for 30 minutes"? This flips the entire Phase 2 shape:
   zero-downtime → dual-write + shadow-read of the new role tables,
   which triples effort; maintenance window → a single migration that
   holds a lock, which is the plan the spec seems to assume.

2. **What are the current production numbers for
   `app_users`, `organizations`, `memberships`, `audit_log`?**
   Without these I cannot size Phase 2 sensibly. Please run against the
   hosted DB:
   ```sql
   SELECT 'app_users', count(*) FROM app_users
   UNION ALL SELECT 'organizations', count(*) FROM organizations
   UNION ALL SELECT 'memberships', count(*) FROM memberships
   UNION ALL SELECT 'audit_log', count(*) FROM audit_log
   UNION ALL SELECT 'multi_org_users',
     count(*) FROM (SELECT user_id FROM memberships GROUP BY user_id HAVING count(*) > 1) x
   UNION ALL SELECT 'orgs_without_owner',
     count(*) FROM organizations o WHERE NOT EXISTS
     (SELECT 1 FROM memberships m WHERE m.organization_id=o.id AND m.role='owner');
   ```

3. **Do today's `locations` become the spec's `branches`, or are
   `branches` a new concept?**
   `locations` carries `type: 'clinic'|'salon'` — that's a vertical
   marker (per-org). Spec `branches` are per-org geography. Options:
   (a) rename `locations` → `branches`, move `type` up to
   `organizations.vertical` (org-level, spec §3);
   (b) keep `locations` as-is under a new name, and `branches` becomes
   a container (`organization → branch → location`).
   The spec doesn't say. Recommend (a): the current dev data supports it
   (each org has locations of a single mixed type today, but spec §3 says
   `vertical` is org-level), and it removes the "salon-and-clinic in one
   org" ambiguity.

4. **What is the production DB provider — Neon, Supabase, or plain
   hosted Postgres?** `.env.supabase` exists in the repo. If Supabase,
   spec §7 (SUPER_ADMIN break-glass) interacts with Supabase's
   `service_role` key management, which is a different security story
   than a self-hosted admin connection.

5. **Is there any current usage of the `SUPPORT_AGENT` shape today —
   i.e., does anyone at Bookpitch need to see customer data?** If yes,
   spec §7.1 (impersonation + consent) is not optional for Phase 5. If
   no (no support team yet), we can defer §7.1 to v2 per spec §11.

6. **Do we need to ship the spec's Redis-backed
   `permissions_version` cache (§10) in Phase 3, or is a Postgres query
   per request acceptable?** Today there's no Redis, and permission
   lookups are effectively free (role is in the JWT). Adding Redis is a
   real infrastructure change. Recommend: skip the cache in Phase 3, add
   it in Phase 5 if the query becomes hot.

7. **The Auth.js `sessionVersion` cache TTL is 5 seconds.** Is that
   still acceptable when it's also the invalidation window for role
   changes? For password reset, 5s is fine. For "user's role was just
   changed while they had a live tab," 5s is also probably fine, but
   it's a policy choice that should be explicit before Phase 3.

8. **Is `bp_active_org` scoped correctly today?** It's `httpOnly + Lax`,
   30-day max-age. But it changes role, which is arguably a
   security-relevant claim. Should it become a shorter-lived cookie that
   the server re-checks, or should the switch trigger a full JWT
   re-issue? See R2 — I recommend a JWT re-issue on switch.

9. **What is our stance on `SUPER_ADMIN` today?** There is no
   platform-plane role in the current schema. If Bookpitch has a founder
   who logs into production with direct DB access, that's the *de
   facto* SUPER_ADMIN and should be captured explicitly in Phase 1 seed
   (single row, MFA required by policy, in a separate `platform_role`
   table per spec §3).

10. **Does the production DB have any custom roles or extensions I'm not
    seeing locally?** Local dev is `bookpitch_app` (non-superuser) + `levan`
    (OS superuser). Production presumably has `bookpitch_app` +
    provider-specific admin. `pgcrypto`, `btree_gist`, `citext` are the
    listed extensions — is anything else installed (e.g. `pgaudit`)?

---

## 10. Concrete evidence trail (so a fresh reader can retrace)

Files I read in full:
- `docs/rbac-spec.md`
- `docs/rbac-promts.md` (only §"Why this is split" — instructed not to
  read ahead)
- `AGENTS.md`, `CLAUDE.md`
- `package.json`, `next.config.ts`, `vercel.json`, `proxy.ts`,
  `vitest.config.ts`
- `auth.ts`, `auth.config.ts`
- `lib/auth.ts`, `lib/auth/password-reset.ts`, `lib/db.ts`,
  `lib/admin.ts`, `lib/audit.ts`, `lib/org-switch.ts`,
  `lib/onboarding.ts`, `lib/invitations.ts`
- `prisma/schema.prisma`, `prisma/seed.ts`
- `prisma/migrations/20260721220810_init/migration.sql`
- `prisma/migrations/20260722000002_add_rls/migration.sql`
- `prisma/migrations/20260722000003_create_app_role/migration.sql`
- `prisma/migrations/20260723000008_audit_partition/migration.sql`
- `tests/setup.ts`, `tests/rls.test.ts`, `tests/rbac.test.ts`,
  `tests/route-access.test.ts`
- `components/shell/nav-items.ts`
- `app/api/notifications/route.ts`, `app/api/push/subscribe/route.ts`
- `ARCHITECTURE.md` (§1–2)
- `docker-compose.yml`, `.env.local` (secret-scrubbed)

Queries run (all read-only, against `bookpitch_dev`):
- Row counts across 9 tenant tables.
- `memberships.role` distribution.
- Users with >1 membership; duplicate emails; orphaned FKs; orgs without
  an active owner.
- `information_schema.columns` — every table's `organization_id` column.
- `pg_class` — RLS status per table.
- `pg_policies` — every active policy.
- Grants on `audit_log` and `verification_tokens` for `bookpitch_app`.
