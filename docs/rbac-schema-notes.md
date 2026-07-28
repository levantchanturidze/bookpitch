# Phase 1 — Schema Notes

Companion to `docs/rbac-spec.md` and `docs/rbac-discovery.md`.
Documents decisions made where the spec was silent, deliberate deviations
and their reasons, and what Phase 2 (data migration) needs to know.

**Scope of Phase 1:** schema and seeds only. No application code changes.
Nothing existing is altered or dropped. The application runs unchanged.

## 1. What shipped in Phase 1

Seven forward migrations (each with a matching `down.sql`), all additive:

| # | Migration | Purpose |
|---|---|---|
| 120000 | `rbac_organizations_columns` | Spec §3 columns on `organizations` |
| 130000 | `rbac_roles_permissions` | New `roles`, `permissions`, `role_permissions` |
| 140000 | `rbac_app_users_columns` | Spec §3 columns on `app_users`, incl. `platform_role_id` FK |
| 150000 | `rbac_branches` | New `branches`, `membership_branches`, RLS |
| 160000 | `rbac_memberships_columns` | Spec §3 columns on `memberships`, incl. `role_id` FK |
| 170000 | `rbac_audit_log_append_only` | Spec §7.1 columns + append-only enforcement |
| 180000 | `audit_log_fk_hardening` | Change SET NULL → NO ACTION FKs + BEFORE TRUNCATE guard |

New seed: `prisma/rbac-seed.ts` (called first by `prisma/seed.ts`). Idempotent.

Tests: `tests/rbac-schema.test.ts` (append-only invariant, RLS on branches),
`tests/rbac-seed.test.ts` (role/permission completeness, idempotency).

Small helper: `tests/helpers/audit-reset.ts` — DEV-only escape hatch for
teardown that needs to hard-delete users with audit history.

## 2. Where the spec was silent — decisions made

### 2.1. Permission keys not literally in spec §5

The spec's §6 matrix references capabilities that §5 doesn't enumerate as
keys. Rather than skip them (leaving matrix cells unenforceable) or invent
ad-hoc English names, we added the following keys. Each is documented in
its seed row.

| Key | Rationale |
|---|---|
| `service.manage` | §6.2 row "Services / categories" needs a key |
| `service.price.manage` | §6.2 row "Prices" — separate from `service.manage` because ADMIN gets prices but BRANCH_MANAGER doesn't |
| `resource.manage:org` / `:branch` | §6.2 row "Resources / rooms" |
| `staff.commission.read` | §6.2 has `staff.commission.manage` (§5) but ACCOUNTANT gets 👁️ (read-only). Split key allows the ceiling |
| `org.billing.read` | Same reason for ACCOUNTANT's 👁️ on billing |
| `audit.read` | Org-level audit view. Spec §5 only defines `platform.audit.read`; §6.2 has OWNER=✅ ADMIN=👁️ on the org audit log |
| `platform.org.delete` | Split from `platform.org.suspend` — SUPER_ADMIN gets it, PLATFORM_ADMIN doesn't |
| `platform.org.owner.change` | §6.1 row "Owner change" — SUPER + PLATFORM |
| `platform.billing.manage` / `.read` | §6.1 row "subscription/tariff/invoices" — SUPER + PLATFORM manage; SUPPORT reads |
| `platform.config.manage` | §6.1 row "feature flags / global config" — SUPER only |
| `platform.analytics.read` | §6.1 row "aggregate analytics (no PII)" — all three platform roles |

Total: **67 permission keys** and **13 system roles** seeded. Full mapping
lives in `prisma/rbac-seed.ts` — the seed file is the source of truth,
matched against the spec via `tests/rbac-seed.test.ts`.

### 2.2. `:any` normalised to `:org`

Spec §5 uses `:any` on `booking.update` and `booking.cancel`. The scope
enum in §5 is (own | branch | org | platform). We normalised `:any` → `:org`
so `can()` in Phase 3 only reasons about four scopes plus the discount
tiers (limited/unlimited) and client-detail tiers (basic/contact/full).

The permission CHECK constraint accepts:
`own | branch | org | platform | limited | unlimited | any | basic | contact | full`
— `any` is allowed in the DB (spec compatibility) but no seed row uses it.

### 2.3. ⚙️ cells (configurable per organization)

Spec §6.2 marks certain matrix cells with ⚙️: capabilities the org owner
can toggle on for a specific role. Phase 1 seeds these at the **most
restrictive** reading (❌) so that the platform defaults to closed. Every
omission is marked with a `// ⚙️` comment in `rbac-seed.ts::ROLE_PERMISSIONS`
so Phase 6 can find them.

Concretely, the following are seeded OFF by default and need per-org toggles
in Phase 6:

- `staff.role.assign` on ORG_ADMIN
- `staff.commission.manage` on ORG_ADMIN
- `report.financial:org`, `report.payroll`, `report.export` on ORG_ADMIN
- `org.integration.manage` on ORG_ADMIN
- `client.read:full` on FRONT_DESK
- `client.read:full` on PROVIDER
- `payment.discount:limited` on FRONT_DESK
- `payment.charge` on PROVIDER
- `payment.refund` on BRANCH_MANAGER
- `service.manage` on BRANCH_MANAGER
- `clinical_note.read:any` on all roles that could plausibly have it
- `clinical_note.create` on ORG_OWNER + ORG_ADMIN (some orgs let non-clinicians create notes; default: only PROVIDER)

Search for `// ⚙️` in `rbac-seed.ts` for the full list.

### 2.4. `CLIENT` role — seeded as a marker

Spec §4.3 explicitly says `CLIENT` is not RBAC-managed (access resolved by
ownership). We still seed the role row (`plane='consumer'`, `rank=0`,
zero permissions). Future code can reference the DB row instead of a magic
string, and the row is a stable identifier for any consumer-side telemetry.

### 2.5. Ranks are a lattice, not a chain

Spec §4.2 warns: `FRONT_DESK` and `PROVIDER` both sit at rank 40 but
operate in different domains. Any "can manage" logic in Phase 3+ must not
use numeric rank as the sole input — see the seed comments and spec §9
rule 2.

`roles.rank` is present for the escalation guard only ("cannot grant a
role at or above your own rank"). "Can this role manage that one" needs
an explicit `can_manage_roles` relation (deferred to Phase 6 unless
Phase 3 needs it sooner).

## 3. Deliberate deviations from spec §3

### 3.1. `organizations.status` default is `active`, not `trial`

Spec §3 sketches `status: trial | active | suspended | archived`, implying
new orgs start in `trial`. We default to `active` because Phase 1 is EXPAND
only — every existing org row must remain valid without a data migration.
Phase 5 will introduce the trial → active state machine and Phase 6 can
change the DEFAULT if the onboarding flow warrants it.

### 3.2. `roles`, `permissions`, `role_permissions` have no RLS

These are reference data. Enabling RLS on `roles` requires a policy that
lets any authenticated caller SELECT system rows (`organization_id IS NULL`)
plus their own-org custom rows. That's a mid-Phase-6 concern (custom roles
don't exist yet). Grants on the schema-wide default privileges let
`bookpitch_app` read them.

### 3.3. `audit_log` — additive columns, keep old shape

The existing `audit_log` (from migration 20260723000008) uses
`entity` / `entity_id` where the spec has `resource_type` / `resource_id`.
We kept the existing names and added the spec §7.1 columns
(`on_behalf_of_user_id`, `user_agent`, `reason`, `impersonation_session_id`,
`break_glass_session_id`). The existing name is preserved so we don't have
to rewrite the ~15 audit writers in application code.

### 3.4. `membership_branches` has no columns beyond the join

Spec §3 lists just `(membership_id, branch_id)`. We added `created_at` for
traceability but no other metadata. Extra columns (e.g. `is_primary`,
`granted_by_user_id`) can come in Phase 6 with the branch-scoping UI.

### 3.5. Branches keep a `legacy_location_id` back-pointer

Not in spec §3. Added because Phase 2 needs to backfill exactly one branch
per existing location, and rollback needs the same 1:1 mapping in reverse.
Unique index enforces the 1:1. Column becomes dead weight after Contract
(months from now) and is dropped then — but until then it's the seam that
makes the migration + rollback tractable.

## 4. The append-only invariant — how it holds and where it doesn't

Spec §9.11 says UPDATE + DELETE on `audit_log` are impossible, including
for SUPER_ADMIN. Phase 1 enforces this via **three layers**:

1. **REVOKE UPDATE, DELETE from `bookpitch_app`** on the parent and every
   partition (grants don't cascade). App-role connections cannot even
   attempt the mutation — Postgres refuses at the permission check.
   Message: `permission denied for table audit_log`.

2. **BEFORE UPDATE / BEFORE DELETE / BEFORE TRUNCATE triggers** on the
   parent. Row triggers on a PARTITIONED parent apply to every partition
   automatically (Postgres 13+). Superuser connections hit these too —
   triggers fire regardless of role. Message:
   `audit_log is append-only (spec §9.11): X is not permitted`.

3. **`bp_create_monthly_partition()` REVOKEs on new partitions** as it
   creates them, so the schema-wide default privileges from migration
   20260722000003 don't grant UPDATE/DELETE back on future rollover
   partitions.

**FK design.** `audit_log.actor_user_id`, `.on_behalf_of_user_id`, and
`.organization_id` are all `ON DELETE NO ACTION`. Deleting a referenced
user or org fails if any audit row points to it. Two consequences:

- **Right to be forgotten** (GDPR / Georgia data-protection law):
  cannot hard-delete an app_user with audit history. Correct pattern is
  to mask PII on `app_users` (email → hashed placeholder, `full_name` →
  redacted, `status = 'deleted'`) while keeping the row + FK intact.
  Phase 6 will implement this properly; the existing
  `lib/gdpr.ts::anonymizeCustomer` already follows a similar pattern
  for customer rows.
- **Dev seed reset.** The `prisma/seed.ts` reset used to hard-delete
  `app_users` at the end. That now trips the FK. Seed uses the
  documented escape hatch: `ALTER TABLE audit_log DISABLE TRIGGER USER`
  → wipe → re-enable. Production never runs `prisma db seed`.

### 4.1. What the invariant DOES survive

- Every application code path, including code that accidentally connects
  as the admin role.
- Any query written by future maintainers via Prisma or raw SQL.
- Bulk operations via CASCADE (FKs are NO ACTION).
- TRUNCATE via the DDL path (BEFORE TRUNCATE trigger blocks it).

### 4.2. What it does NOT survive

- A superuser explicitly running `ALTER TABLE audit_log DISABLE TRIGGER`,
  mutating, then re-enabling. The DDL leaves a trail in `pg_stat` and
  the Supabase platform audit. The spec accepts this — friction is
  high, the operation is unmistakable in review, and it's the only way
  to reset a dev DB.
- `DROP TABLE audit_log CASCADE` by a superuser wipes everything. The
  database owner has ultimate power over their DB. Mitigation is
  external:
  - Regular off-site snapshots (Supabase daily backups + PITR — already
    verified in migration 824dd70 per `docs/rbac-discovery.md`).
  - WORM-style off-site copy (not in scope for MVP; would require
    Phase 5+).
  - Alerting on any DDL against `audit_log`.

### 4.3. TRUNCATE trigger caveats

The BEFORE TRUNCATE trigger fires on every attempt including the
partitioned parent's cascade to partitions. It cannot distinguish a
`TRUNCATE audit_log` from a `TRUNCATE some_other_table CASCADE` that
would cascade in — but nothing FKs to `audit_log`, so no cascade path
exists today. If a future table FKs to `audit_log` with `ON DELETE
CASCADE`, this design should be revisited.

## 5. What Phase 2 needs to know

### 5.1. Backfill order

Phase 2 must fill the new columns in this order (each step is a batch):

1. **`organizations.vertical`** ← from the majority `locations.type` per
   org. Multi-typed orgs (like `Grand Medical & Aurora Spa Group` today)
   get `vertical = 'mixed'`.
2. **`branches`** ← one row per `locations` row. Set
   `legacy_location_id = locations.id`, `name = locations.name`,
   `timezone = locations.timezone`.
3. **`organizations.owner_user_id`** ← from the first
   `memberships (role='owner')` row (ordered by `createdAt`).
4. **`memberships.role_id`** ← lookup by `role` enum value:
   `owner → ORG_OWNER`, `practitioner → PROVIDER`,
   `receptionist → FRONT_DESK`.
5. **`memberships.joined_at`** ← copy `createdAt`.
6. **`memberships.is_bookable`** ← `true` when
   `role IN ('owner','practitioner')` (existing bookable roles),
   `false` otherwise. This becomes editable in Phase 6.
7. **`app_users.status`** ← default `active` handles existing rows; no
   manual step unless the discovery found soft-deleted rows (none in
   prod).

### 5.2. Uniqueness during transition

The old `UNIQUE (organization_id, user_id)` index still exists. During
Phase 2, both the old and new uniqueness are active:
- Old: max one row per (org, user) — legacy enum enforcement.
- New: max one row per (user, org, role_id) — partial on `role_id IS NOT NULL`.

This means during backfill: as soon as `role_id` is populated on a
membership row, its (user, org, role_id) tuple becomes unique. Since the
old unique already enforces one row per (org, user), no conflict is
possible.

**After Phase 4**, when application code stops depending on the enum, the
Contract migration can drop `UNIQUE (organization_id, user_id)` to allow
one user to hold multiple roles in the same org (spec §2.3 solo
practitioner).

### 5.3. Dual-write scope

Every write path that creates or modifies memberships / organizations /
locations must also update the new columns. Phase 2 will enumerate these
per spec §"Two separate problems". The list from Phase 0's discovery is
the starting point:

- `lib/onboarding.ts::onboardOrg` — creates org + location + owner
  membership. Add: `organizations.vertical` (from `locationType`),
  `organizations.owner_user_id`, `branches` row, `memberships.role_id`
  + `.joined_at` + `.is_bookable`.
- `lib/admin.ts::inviteMember` — creates user + membership. Add:
  `memberships.role_id` + `.joined_at` + `.invited_by_user_id`.
- `lib/admin.ts::createLocation` — must also create a `branches` row.
- `lib/admin.ts::updateLocation` — must sync the linked `branches` row.
- `lib/admin.ts::deleteLocation` — must delete the linked `branches`.
- `lib/invitations.ts::acceptInvitation` — creates membership. Add
  `role_id`, `joined_at`, `is_bookable`.

Failure mode decision (spec §Phase 2): if the new-model write fails,
does the old-model write roll back? Recommend YES — wrap both in the
same `withOrg` transaction. But that's a Phase 2 design decision, not
Phase 1.

### 5.4. SUPER_ADMIN seed

Phase 0 Q9 answer: seed `levaaani@gmail.com` as SUPER_ADMIN. This is
NOT done in Phase 1 because the app_user row for that email doesn't
exist in the prod DB yet (prod has 2 different dev users). The seed
step is either:
- Phase 2: create the app_user, then set `platform_role_id = SUPER_ADMIN.id`.
- Manually after the account signs up: `UPDATE app_users SET platform_role_id = ... WHERE email = 'levaaani@gmail.com'`.

Recommend Phase 2 handles it as part of the backfill.

### 5.5. What tests need

Phase 2 will need multi-tenant fixtures (three orgs, one user in two of
them, one solo practitioner holding OWNER + PROVIDER) per Phase 3. Those
don't exist yet; today's fixtures are `Grand Medical & Aurora Spa Group`
+ `Isolation Corp` with no shared users. Phase 3's prompt owns building
these — Phase 2 doesn't need them for the backfill itself.

## 6. Rollback

Each migration has a matching `down.sql` in the same folder. Verified by
running the sequence forward → backward → forward on the local dev DB
during Phase 1 development:

```bash
# Forward (already applied by prisma migrate deploy)

# Backward — one migration at a time, in reverse order:
for f in 20260727180000_audit_log_fk_hardening \
         20260727170000_rbac_audit_log_append_only \
         20260727160000_rbac_memberships_columns \
         20260727150000_rbac_branches \
         20260727140000_rbac_app_users_columns \
         20260727130000_rbac_roles_permissions \
         20260727120000_rbac_organizations_columns; do
  psql "$ADMIN_DATABASE_URL" -f "prisma/migrations/$f/down.sql"
  psql "$ADMIN_DATABASE_URL" -c "DELETE FROM _prisma_migrations WHERE migration_name='$f';"
done

# Forward again — proves the migrations converge on the same state:
DATABASE_URL="$ADMIN_DATABASE_URL" npx prisma migrate deploy
```

Prisma does not run `down.sql` automatically — this is intentional. Any
production rollback must be a deliberate human action, and each `down.sql`
was written by hand to reverse its `migration.sql` exactly.

## 7. Verification

Local dev DB, `Postgres 16.14`:
- `npx prisma migrate deploy` — 25 migrations applied cleanly.
- `npx prisma db seed` — reference data + tenant data seeded; the RBAC
  seed reports `{ roleCount: 13, permCount: 67, rpCount: 214 }`.
- `node --env-file=.env.local ./node_modules/.bin/tsx prisma/rbac-seed.ts`
  — runs standalone, produces identical counts across 3 back-to-back
  runs (idempotency proven).
- `npm test` — 38 test files, 217 tests, all passing. Two back-to-back
  runs both green (teardown hygiene proven).
- Append-only invariant: verified from both `bookpitch_app` (denial via
  REVOKE) and the OS superuser `levan` (denial via trigger).

Not yet verified (Phase 2 work):
- Migrations against a full copy of production data.
- Reconciliation between old and new columns after backfill.

## 7. Phase 3 additions

Two additive migrations + a JWT-shape change on top of Phase 1/2.

### 7.1. `role_can_manage` table (migration 20260728100000)

Rank alone can't distinguish FRONT_DESK and PROVIDER (both rank 40 but
operating in different domains — spec §4.2 lattice warning).
`lib/rbac/rank.ts::canManageRoleAssignment` combines both:

1. Numeric: `actor.rank > target.rank` (strict `>` blocks same-rank peers)
2. Explicit lattice edge in `role_can_manage`

The lattice is data-driven and seeded by `prisma/rbac-seed.ts::upsertRoleCanManage`
per spec §4.2. Current edges:

```
SUPER_ADMIN     → PLATFORM_ADMIN, BILLING_MANAGER, SUPPORT_AGENT
PLATFORM_ADMIN  → SUPPORT_AGENT
ORG_OWNER       → ORG_ADMIN, BRANCH_MANAGER, SENIOR_PROVIDER,
                  FRONT_DESK, PROVIDER, ACCOUNTANT, MARKETING
ORG_ADMIN       → BRANCH_MANAGER, SENIOR_PROVIDER, FRONT_DESK,
                  PROVIDER, ACCOUNTANT, MARKETING
BRANCH_MANAGER  → FRONT_DESK, PROVIDER
SENIOR_PROVIDER → PROVIDER
```

CHECK constraint on the table forbids self-loops (no role manages itself,
per spec §9 rule 3). CASCADE on both role FKs so deleting a role removes
its edges rather than orphaning them.

### 7.2. Force re-auth on Phase 3 deploy (migration 20260728110000)

Phase 3 changes the JWT payload shape (adds `activeOrganizationId`,
`membershipId`, `platformRoleId`). Rather than write a compat shim for
the old shape, we invalidate every live JWT by bumping
`app_users.sessionVersion`. The `session()` callback in `auth.ts`
rejects any JWT whose sessionVersion is stale (5s TTL cache), so users
re-authenticate on their next request.

Phase 0 Q1 accepted this cost: prod has 2 users, sub-5s re-auth is
imperceptible. Rollback decrements symmetrically (worst case one extra
forced re-auth per user — harmless).

### 7.3. AuthContext cache design

In-memory `Map<key, {ctx, at}>` in `lib/rbac/context.ts`, 30s TTL,
1000-entry bound. Key: `m:${membershipId}:${sessionVersion}` for
org-plane contexts, `u:${userId}:${sessionVersion}` for platform-only.

Deviates from the spec's "Redis-backed with permissions_version"
prescription — Phase 0 Q6 chose to defer Redis. Consequences we accept:

- **Worst-case stale window: 30s.** A role/permission change (a Phase 6
  admin edit that will exist someday) propagates to every session,
  everywhere, within 30s. Users won't notice.
- **No cross-Node coherence.** Each Node process holds its own cache.
  Vercel's Node runtime spawns processes on demand; the cache is
  per-instance. Fine at MVP scale; will need re-thinking with fleet
  scaling.
- **sessionVersion bump = instant invalidation.** Any code path that needs
  faster than 30s (org switch, password reset) bumps `sessionVersion`
  and the next call rebuilds. This is why the org-switch flow works.

If load metrics justify it, Phase 5 can add a `roles.permissions_version`
column + JWT claim + a Redis cache. Signature stays stable.

### 7.4. Solo-practitioner two-role limitation

Spec §2.3 wants a solo doc to hold ORG_OWNER + PROVIDER as two
distinct memberships in the same org. Phase 1 added the partial unique
`(user_id, organization_id, role_id)` (WHERE role_id IS NOT NULL) that
allows this. But the legacy unique `(organization_id, user_id)` from
before RBAC still exists and forbids it — every membership row still
carries a legacy `role` enum, and one enum row per (org, user).

MVP behavior: solo doc gets ONE membership row (enum='owner',
role_id=ORG_OWNER). The PROVIDER hat is not modelled as a separate
membership yet. `prisma/rbac-fixtures.ts::solo@bp.test` reflects this.

Fix path: Phase 4 relaxes the legacy unique when it swaps write paths off
the enum column. At that point the seed can add the second (PROVIDER)
membership row and the tests in `tests/rbac-fixtures.test.ts` can assert
the two-role invariant. Tracked as a Phase 4 follow-up.

### 7.5. Org-switch is now a re-sign-in

`lib/org-switch.ts::switchActiveOrg` no longer touches cookies. It verifies
the target membership and bumps `sessionVersion`; the frontend follows
with `signIn('credentials', { orgId })` and Auth.js mints a fresh JWT
with the new membership selected. `resolveActiveOrg` was deleted along
with the `bp_active_org` cookie.

Trade-off: one extra HTTP round-trip on org switch. In return: no
cookie/JWT drift, no request-time DB lookup for the active org, and the
AuthContext cache stays keyed on a stable JWT payload.

