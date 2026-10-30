# Tenant isolation audit (DEF-08)

**Dated 2026-10-31.** Counts are a snapshot of this branch; regenerate them with
`npx tsx scripts/tenant-query-inventory.ts` rather than quoting them later.

CLAUDE.md invariant 1: every query touching tenant data filters by
`organization_id`, and a query without it is a bug "regardless of what the
surrounding code appears to guarantee". The 2026-10-28 backlog round (DEF-08)
found most tenant queries relying on RLS alone and recorded it for the owner.
This audit asks the question DEF-08 left open: **can an id from another tenant
reach or change a record anywhere today?**

**Answer: not while RLS holds, and production verifies RLS on every
migration run. Where RLS is taken away, the authorisation resolvers were a real
cross-tenant write path; they now name the organisation (§5).** Everything
else is defence in depth, proposed as a separate change (§7).

## 1. Method

`scripts/tenant-query-inventory.ts` parses every `.ts`/`.tsx` file under
`app/`, `lib/` and `components/` with the TypeScript compiler and records each
Prisma call on a tenant model and each raw SQL statement naming a tenant table:

| Field | Meaning |
|---|---|
| `context` | What enforces the boundary if the query names no organisation. `rls`: inside `withOrg()`/`withOrgReplica()`, using the client they hand in. `bypass`: `withoutRls()`, `unsafePrismaAdmin`, `prismaLogin`, or a `$transaction` on one of them, so **nothing** filters. `caller-tx`: a client passed in by the caller. `app-no-org`/`unknown`: none today, and a test keeps it that way |
| `orgNamed` | The query names the organisation: an `organizationId` key, a compound unique key containing it, a relation through a model that carries it, `id` on the organization model, or `organization_id` in SQL, including inside a reused SQL fragment |
| `byId` | The query is keyed by one record's id, the shape an IDOR uses |

It is syntactic: it sees that a query names `organizationId: x`, not where `x`
comes from. That is why every `bypass` row was also read by hand (§4).
`tests/tenant-query-inventory.test.ts` pins the classifier with synthetic cases,
so a broken classifier fails instead of passing everything.

## 2. RLS posture (measured on the local database, 74 migrations)

- Every table carrying `organization_id` has RLS **enabled and forced**, and one
  `tenant_isolation` policy, `USING` and `WITH CHECK`
  `organization_id = current_org_id()`. `audit_log` also admits
  `organization_id IS NULL` (platform rows).
- The derived tables, `membership_branches`, `staff_availability` and
  `treatment_history`, are enabled and forced, with policies through their
  parent's `organization_id`. `organizations` is scoped by `id`.
- `bookpitch_app` (runtime, `DATABASE_URL`) is `NOSUPERUSER NOBYPASSRLS`.
- Two tables carry `organization_id` without RLS:
  - `roles`: every role read filters `organizationId: null` (the system roles),
    and no code creates organisation roles. There are 13 rows locally, none
    organisation-scoped.
  - `impersonation_sessions`: platform plane, read and written only on the
    bypass client by actor.

  Neither is reachable across tenants.
- **Production:** `scripts/verify-production-invariants.sql` runs on every
  `migrate.yml` invocation. It fails unless:
  - the app role is neither superuser nor `BYPASSRLS`;
  - every required tenant relation, audit partitions included, has RLS
    enabled and forced;
  - each has exactly one permissive `tenant_isolation` policy with the exact
    predicate.

  So "RLS holds" is checked in production, not assumed.

## 3. Counts (2026-10-31)

| Context | Names the org | Names no org | Of those, keyed by id |
|---|---|---|---|
| `rls` | 42 | 98 | 63 |
| `caller-tx` | 5 | 29 | 11 |
| `bypass` | 79 | 41 | 23 |
| **Total: 294 sites** | 126 | 168 | |

On `main` before this change, `rls` was 37 / 103. The difference is the five
resolver queries in §5. The 2026-10-28 round's "135 of 150" used a narrower
model set and no raw SQL, so the totals differ.

## 4. The bypass rows: all 41 read by hand

Nothing filters these, so each key's source was traced. **No cross-tenant path
was found.** The list, with the reason for each, is `REVIEWED_BYPASS` in
`tests/tenant-query-inventory.test.ts`. A new bypass query naming no
organisation fails that test until it is reviewed the same way, and a reviewed
one that disappears fails it too. The inventory was also run over every open
pull request (#111–#127): none adds or removes a row, so the list holds in any
merge order.

| Reason | Rows | Examples |
|---|---|---|
| System job over every organisation | 7 | housekeeping sweeps (expired rate-limit windows, read notifications, expired break-glass and impersonation sessions); ops-metrics counts; the reminders cron's organisation count |
| Keyed to the acting user | 11 | ownership transfer lookups pinned to `toUserId`/`fromUserId = session.userId`; break-glass and impersonation keyed by `actor_user_id` or the session id in the actor's own auth context |
| Keyed by a secret token | 3 | invitation acceptance by token hash; the organisation is the invitation row's |
| Keyed by a signature-verified callback | 3 | `applyWebhook`: TBC/mock HMAC compared with `timingSafeEqual`, BOG RSA, Stripe `constructEvent` |
| Keyed by an id already proven to be the organisation's | 13 | the reminder send pipeline (send-now checks the organisation explicitly first, #125; the cron selects per organisation); ownership-transfer writes after the pinned read; retention writes after its org-filtered candidate read; public booking's consent stamp on a customer matched under the location's organisation |
| Platform plane, behind a platform permission | 2 | `listOrganizations`, `changeOrganizationOwner` |
| Creates the organisation | 2 | onboarding |

The 29 `caller-tx` rows were traced to their callers. All run inside `withOrg`
except `assignAllBranchesIfUnscoped`, which invitation acceptance calls on the
bypass client. It filters `branches` by `organizationId` explicitly, with a
comment saying why.

Also checked, and no defect found:
- No `withOrg()` takes its organisation from request input. Every call site
  passes the session's organisation, or one read from a location the server
  resolved (public booking).

## 5. Fixed: the authorisation resolvers named no organisation

`lib/rbac/scope.ts` is where a concrete mutation is authorised:
- `resolveAppointmentResource`, `resolveStaffResource`,
  `resolveWaitlistResource` and `resolveBookingOwner`;
- the branch-to-location map behind `scopedLocationIds`.

Each loads one row and returns a `Resource` that **asserts**
`organizationId: <the caller's organisation>`. `can()` then authorises against
that assertion. Each read was `where: { id }` inside `withOrg`, so the
assertion was true only because RLS made it so. This is the same shape #125
fixed for send-now (DEF-07) and #126 for `assertCustomerInOrg`.

**Measured, with RLS taken away** (`withOrg` run on the bypass client, as
#125's send-now test does):
- organisation A's owner `PATCH`ed organisation B's appointment to
  `cancelled`, and got **200**;
- the same owner deleted B's waitlist entry, and got **200**.

With the explicit filter, both answer **404** and change nothing. The
complements still pass: B's own owner resolves and deletes through the same
routes, without RLS.

| Test | Result |
|---|---|
| `tests/tenant-scope-resolvers.test.ts`, with the fix | 6 passed |
| The same, resolvers reverted to `main` | **4 red** (both complements pass) |
| `tests/tenant-query-inventory.test.ts` | 6 passed |
| A new unreviewed bypass query added | 1 red, naming it |
| A resolver's filter removed | 1 red, naming the resolver |
| The classifier broken (everything `rls`) | 3 red |

The change is behaviour-preserving while RLS holds: RLS already filters to the
same organisation.

## 6. Not defects, recorded

- **Ownership transfer:** `declineTransfer` and `revokeTransfer` check
  `status === 'pending'`, then update by id with no status predicate and a
  Node-clock `decidedAt`. Racing an `acceptTransfer`, either can relabel an
  accepted transfer as declined or revoked after ownership moved. That is a
  record-integrity race, not tenancy: `acceptTransfer` itself is atomic. It is
  the shape DEF-15 fixed for password resets. Not changed here, to keep this
  pull request to one concern.

## 7. Proposal: name the organisation everywhere else (a separate pull request)

98 `rls` rows and 29 `caller-tx` rows still rely on RLS alone. None is a hole
while RLS holds (§2), but invariant 1 asks for the filter anyway. Proposed, in
priority order, each its own reviewable commit:

1. **Writes keyed by id (25):**
   - customer update and delete (API route and Server Action);
   - location, staff and service update and delete (`lib/admin.ts`);
   - membership role change and removal;
   - template update; invitation revoke;
   - payment updates (`startCardCheckout`, `settleCash`);
   - `removeFromWaitlist`;
   - the appointment update behind each resolver;
   - the cleanup lifecycle.

   Prisma's extended unique `where` takes `{ id, organizationId }` directly, so
   each is a one-line change.
2. **Reads keyed by id (38):** the same, with `findUnique` becoming `findFirst`
   where the selector is not unique.
3. **List reads and bulk writes (35):** add `organizationId` to the `where`.
4. **`caller-tx` helpers (29):** take the organisation as a parameter, as
   `assertCustomerInOrg` does since #126.

Each step's test is this audit's technique: the operation with RLS taken away,
another organisation's id refused, and the same-organisation complement allowed.
After step 4, `tests/tenant-query-inventory.test.ts` can require `orgNamed` for
every `rls` row as well, which makes invariant 1 a CI check.

**Owner decision:** schedule the sweep, or accept RLS (verified on every
migration) as the enforcer for the rest. This pull request does not decide it.
