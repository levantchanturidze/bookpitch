# Scoped RBAC: assumption audit before implementation (C7)

**Date:** 2026-09-28. **Candidate:** `08cba4f` (`main`). **Status:** read-only.
No product code, migration or test in the repository was changed to produce
this record.

**Update (2026-09-28):** the two live escalations in §3.6 are fixed as **U-06**
in a separate hotfix (owner decision D3). See
`tests/u06-action-resource-scope.test.ts`, which failed 6 of 10 against the
unfixed code and passes 10 of 10 with the fix. Everything else below is still
open and belongs to the scoped-RBAC change.

This document validates two assumptions in the agreed scoped-RBAC design (the
design reconstruction of 2026-09-28 that closes UAT row C7) before any of it is
implemented. The review brief said to implement only after both assumptions
were proven.

**Neither assumption holds as stated.** Section 1 gives the verdicts, sections 2
and 3 give the evidence, and section 4 records runtime proof against the local
database. Section 6 lists the decisions that need the owner before any code
changes.

---

## 1. Verdicts

| # | Assumption | Verdict | Consequence |
|---|---|---|---|
| 1 | One practitioner has at most one Staff row per organization, so `UNIQUE (organization_id, user_id) WHERE user_id IS NOT NULL` is safe | **Disproven.** The data model can represent a practitioner who works at two locations of one organization *only* as two Staff rows, and the product supports multi-location organizations. | Reject `(organization_id, user_id)`. Chosen invariant: **`UNIQUE (location_id, user_id) WHERE user_id IS NOT NULL`** (§2.5). |
| 2 | Every branch-scoped list path filters rows by `ctx.branchIds` itself, so `can()` list mode never turns an empty branch set into org-wide visibility | **Disproven.** An empty set is org-wide **by deliberate, documented design**. Three list surfaces apply no branch filter at all. `can()` compares branch ids with location ids, so a correctly assigned branch can never match. Six concrete operations name no branch. | The agreed three-state rule is still correct, but it is not safe until the list paths, the id space and the concrete call sites are fixed (§3, §5). |

---

## 2. Assumption 1: Staff ↔ user cardinality

### 2.1 Question

Can one app user legitimately need more than one `staff` row inside the
**same** organization, for example one per location? If so, the proposed partial unique
`(organization_id, user_id)` would forbid linking the second row, and that
practitioner's appointments at the second location would stay unowned
permanently.

### 2.2 Evidence

| Source | What it says | Implication |
|---|---|---|
| `prisma/schema.prisma:307` | `Staff.locationId` is a single `NOT NULL` column | A staff row belongs to exactly one location |
| `prisma/schema.prisma:351-379` | `StaffAvailability` has `staffId`, `weekday` and times, and **no location column** | Different hours at two locations need two staff rows |
| `lib/appointments.ts:184-194` `assertStaffAtLocation` | Booking requires `staff.locationId = appointment.locationId`, on both create and update paths | A practitioner cannot be booked at location B through a location-A staff row |
| `lib/appointments.ts:217-224` | Availability is evaluated in `staff.location.timezone` | One staff row has one timezone, the timezone of its location |
| `prisma/schema.prisma:388`, `lib/appointments.ts:172-182` | Services are per location. `loadServiceForLocation` requires `service.locationId = appointment.locationId` | The service catalogue is per site as well |
| `prisma/migrations/20260721220810_init/migration.sql:393-398` | GiST exclusion `no_staff_double_booking` is on `(staff_id, range)` | Calendars are kept per staff **row** |
| `ARCHITECTURE.md:66-67` | "`location` = one physical business … An org can own several" | Multi-location organizations are the product model |
| `CLAUDE_CODE_PROMPTS.md:291-301` (P3.4) | "Multi-location administration: let an owner run several businesses from one account … create/edit locations, staff (+ availability windows)" | Multi-location is a built feature, not a hypothetical |
| `prisma/seed.ts:29-30, 169-174, 347` | The seed organization has two locations. Each staff row is placed at one location, and seeded appointments take `locationId: staffRow.locationId` | Consistent with a staff row being a (person, location) pair |
| `schema.sql:91` | `user_id … -- if staff also logs in`, with no uniqueness | The original design never constrained how many staff rows one user may have |
| `lib/admin.ts:194-232` (`createStaff` / `updateStaff`) | Takes one `locationId`, with no dedup on email or name. Update can *move* a row to another location but cannot give it two locations | Recording the same person at a second location means creating a second row |
| `components/settings/StaffPanel.tsx:225-235` | The staff form has a single **Location** select | Same |
| `prisma/schema.prisma:217` | `AppUser.staffProfiles Staff[]`, a plural relation | The model already expects N rows per user |
| `lib/waitlist.ts:73-77`, `app/api/appointments/route.ts:58`, `app/(app)/scheduler/page.tsx:49` | Every user-keyed staff read is a `findMany` or a relation filter `{ staff: { userId } }`. None is a `findUnique` by user | Every reader already tolerates N staff rows per user |
| `docs/rbac-spec.md:75` §2.3 scenario 1 | "A doctor working in two clinics, PROVIDER in clinic A and PROVIDER in clinic B, **with different schedules**" | Ambiguous. The spec's remedy (memberships) points to two *organizations*. In `ARCHITECTURE.md` vocabulary, however, a clinic is a *location*, and "different schedules" maps exactly onto per-row availability. Both readings must work. |
| `prisma/rbac-fixtures.ts`, `scripts/create-test-org.ts` | No fixture links any staff row to a user. The multi-org "moonlighter" spans organizations | No fixture models either answer, so fixtures cannot settle the question |

Nothing in the specification, the architecture document, the prompts, the
schema, the fixtures or the tests says a practitioner works at only one location of an
organization.

### 2.3 What `(organization_id, user_id)` would break

Take Dr. A, who practises at both locations of one organization:

1. The owner creates staff row **S1** at location L1 and **S2** at L2, each with
   its own availability. This is the only way the model can express it
   (§2.2).
2. The owner links S1 to Dr. A's account. The link succeeds.
3. Linking S2 violates `UNIQUE (organization_id, user_id)` and is refused.
4. Every appointment on S2 resolves `ownerUserId = null`. Under U-05's
   three-state rule, `:own` denies. Dr. A cannot update, cancel or reschedule any
   of their own L2 bookings, and `booking.read:own` hides those bookings from
   their calendar (`staff.userId = caller` does not match S2).

This fails closed, so it is not an escalation. It does permanently disable the
exact PROVIDER function the C7 work exists to restore.

### 2.4 Rejected alternatives

- **`(organization_id, user_id)`**: breaks §2.3.
- **Global `UNIQUE (user_id)`**: also breaks spec scenario 1 across
  organizations. Already rejected in the design reconstruction.
- **One org-level staff row with a `staff_locations` join and per-location
  availability**: this is a staff-management redesign that touches availability, the
  booking guards and the GiST constraint. It is out of scope under the C7 brief
  ("avoid building a broad staff-management redesign").

### 2.5 Conclusion and chosen invariant

**At most one linked staff row per `(location_id, user_id)`**, enforced by

```sql
CREATE UNIQUE INDEX staff_location_user_unique
    ON staff (location_id, user_id) WHERE user_id IS NOT NULL;
```

- This preserves multi-location practice inside one organization (N rows, one per
  location) and multi-organization practice (spec scenario 1, either reading).
- It forbids two linked rows for one person at **one** location. That state has
  no product meaning. It would split one person's calendar across two
  `staff_id`s at a single site, which defeats the per-`staff_id` double-booking
  guarantee, and it is exactly the "ambiguous duplicate mapping" the C7 brief prohibits.
- Tenant safety is enforced in the linking transaction, not by the index. The
  staff row is read through `withOrg` (RLS), and the target user must hold an
  **active membership in the same organization**. A cross-organization link is
  unrepresentable. Optional DB hardening, not required: a composite FK
  `staff (organization_id, user_id) → memberships (organization_id, user_id)`
  would make it structural, but it couples to the legacy
  `UNIQUE (organization_id, user_id)` on memberships, which the Contract phase
  intends to drop (`docs/rbac-schema-notes.md` §5.2).
- Production state: `staff.user_id` is NULL on every row (U-05 finding: nothing
  has ever written it), so the index cannot conflict at creation.

### 2.6 Known limitation, pre-existing and not introduced here

The GiST constraint is per `staff_id`. A person with rows at L1 and L2 can be
double-booked **across** locations. That is already true today for the same
person entered twice without a link. Linking both rows to one `user_id` is what
makes a future cross-row check possible, so the chosen invariant moves toward
closing the gap. Recorded, not addressed in C7.

---

## 3. Assumption 2: branch list-mode enforcement

### 3.1 Rule under test

The agreed rule for `:branch` in `can()`:

| `resource.branchId` | `ctx.branchIds` | outcome |
|---|---|---|
| absent (list mode) | anything | grant, and **the query must filter** |
| present | empty | deny |
| present | populated | membership test |

The rule is safe only if every list path filters rows by the caller's branch
scope by itself, including returning **zero** rows for an empty set.

### 3.2 Current semantics: an empty set is org-wide on purpose

The current code does not fail closed here by accident. It was designed and documented
to treat an empty set as unrestricted:

- `lib/rbac/can.ts:14-18, 104-116`: "Empty `ctx.branchIds` → unrestricted
  (FRONT_DESK is `:branch` by role but has no per-branch scoping). Always
  allow."
- `lib/rbac/scope.ts:132-133`: `scopedLocationIds()` returns `null` (no filter)
  whenever the set is empty, **for every caller regardless of grant**.
- `prisma/migrations/20260727150000_rbac_branches/migration.sql:9-11`: "Absent
  membership_branches row means 'unrestricted within the org'".
- `docs/rbac-guarding-endpoints.md:188-191, 456-459` and
  `docs/rbac-enforcement-audit.md:85-87` say the same.
- `tests/branch-scoping.test.ts:30-32`: "unrestricted roles (FRONT_DESK with
  empty branchIds) keep org-wide reach".

The specification says the opposite. The §10 reference `can()` is
`return ctx.branchIds.includes(resource?.branchId)`, which denies for an empty set
and in list mode. §2.3 scenario 4 describes FRONT_DESK "with the scope of two
branches". This is the spec-versus-code contradiction that CLAUDE.md requires to
be resolved explicitly. The review brief resolves the direction: **an empty set
must yield zero rows.** The transition for existing users is not yet decided
(§6, D1).

**Who is affected in production.** Only three roles hold `:branch` grants: FRONT_DESK
(`booking.read/update/cancel/block_time:branch`), BRANCH_MANAGER and
SENIOR_PROVIDER (`prisma/migrations/20260810000006_seed_rbac_reference_data`
lines 258-303, 327-348). Invitations and role changes accept only
`owner | practitioner | receptionist` (`lib/admin.ts:23`), and ownership
transfer can additionally produce ORG_ADMIN. **FRONT_DESK is therefore the only
production role with `:branch` grants, and every FRONT_DESK membership has an
empty set**, because nothing writes `membership_branches`.

### 3.3 Caller audit

Covers every caller of a `booking.*` permission (which FRONT_DESK and
BRANCH_MANAGER hold at `:branch`), of `staff.schedule.manage` (`:branch` for
SENIOR_PROVIDER and BRANCH_MANAGER, `:own` for PROVIDER) and of
`scopedLocationIds()`, and every other query that lists appointments or
waitlist rows. `booking.block_time` and `resource.manage` have no callers, and
their seed rows are marked NOT YET IMPLEMENTED.

**List and query paths**

| Path | Guard | Branch filter today | Empty set today | Populated set today | Verdict |
|---|---|---|---|---|---|
| `app/api/appointments/route.ts:43-51` GET | `booking.read` list mode | `scopedLocationIds(ctx)` | **org-wide** (null → no filter) | filtered ✓ | fails on empty set |
| `app/(app)/scheduler/page.tsx:47-50, 87-114` | `booking.read` list mode | `scopedLocationIds(ctx)` against the active location | **any location**; the switcher lists all (`lib/active-location.ts:22-46`) | filtered ✓ | fails on empty set |
| `app/api/waitlist/route.ts:21-26` GET → `lib/waitlist.ts:91-93` | `booking.read` list mode | `OR: [locationId IS NULL, locationId IN scoped]` | **org-wide** | **no-op in practice**: the waitlist UI never sets `locationId` (`app/(app)/waitlist/WaitlistView.tsx:40-47`), so every row is NULL and passes | fails both |
| `app/(app)/waitlist/page.tsx:20` | `booking.read` list mode | **none**. Calls `listWaitlist(session)` with no options, so **no `:own` filter either** | org-wide | org-wide | fails both. `docs/features-en.md:22` claims this page is filtered |
| `app/(app)/reminders/page.tsx:42-53` upcoming list | `booking.update` list mode | **none** (active location only, no scope, no `:own`). Returns customer phone and email | any location | any location | fails both. Also an `:own` leak for PROVIDER |
| `app/(app)/reminders/page.tsx:55-63` message log | `booking.update` list mode | **none, org-wide**, including recipient `toAddress` | org-wide | org-wide | fails both |
| `app/(app)/billing/page.tsx:34-50` | `payment.charge` (scope-less) | **none** (active location only) | any location | any location | fails both. The list is booking data |
| `components/scheduler/actions.ts:247-268` `fetchAvailableSlotsAction(staffId)` | `booking.read` list mode | **none**. Any staff id in the org | any | any | discloses another branch's occupancy |
| `lib/rbac/landing.ts:41`, `components/shell/nav-items.ts` | list mode (UI only) | n/a | n/a | n/a | fine: routing only, no data |

**Concrete operations, where the agreed rule needs a real branch id**

| Path | Resource passed | Result |
|---|---|---|
| `app/api/appointments/[id]/route.ts:43-47` PATCH | resolved owner + **location id as `branchId`** | populated set: in-branch **denied** (§3.4). Empty set: allowed |
| `components/scheduler/actions.ts:148-164` `updateAppointmentAction` | same | same |
| `components/scheduler/reschedule-actions.ts:47-69` | same | same |
| `app/api/waitlist/[id]/route.ts:17-25` DELETE | owner only, **no `branchId`** → list mode | any row in any branch. Proven in P7 |
| `app/api/reminders/send-now/route.ts:16-23` | owner only, **no `branchId`** | any appointment in any branch |
| `components/reminders/actions.ts:16-20, 81-87` `sendNowAction` | **nothing** (`{ organizationId }`) | **any appointment, `:own` included**, which is a live U-05-class escalation (P5) |
| `app/api/admin/staff/[id]/availability/route.ts:22-36` PUT | owner only, **no `branchId`** | `:branch` callers reach any staff member |
| `components/settings/actions.ts:54-58, 118-137` `setAvailabilityAction` | **nothing** | **any staff member's schedule, `:own` included**, which is a live U-05-class escalation (P6) |

### 3.4 Defect A: `can()` 4b compares two different id spaces

`ctx.branchIds` holds **`branches.id`** (`lib/rbac/context.ts:234, 265`). Every
concrete appointment resource carries **`locations.id`** in `branchId`
(`lib/rbac/scope.ts:183`, `appointmentResource`: `branchId: opts.locationId`).
The two never coincide. `branches.id` is `gen_random_uuid()`
(`prisma/migrations/20260727150000_rbac_branches/migration.sql:15`), and the
sync trigger links the two tables only through `legacy_location_id`
(`prisma/migrations/20260728000100_rbac_sync_triggers/migration.sql:86-92`).

A populated branch set therefore **denies every concrete appointment,
including those in the caller's own branch**. It fails closed, so it is not an
escalation, but the "membership test" in the agreed rule can never return
true. **C7 branch-allow cannot pass until this is fixed.** Proven in P1.

It went unnoticed because `tests/scheduler-resource-scope.test.ts:37-38, 152-160`
uses one synthetic constant (`BRANCH_A`) both as the entry in `ctx.branchIds`
and as the appointment's `locationId`. The test passes, and production would
deny. This is the pattern recorded in memory as "a fixture that mirrors the
implementation can only confirm it".

### 3.5 Defect B: three list surfaces filter nothing

These are the waitlist page, the reminders page (upcoming list and message log) and the billing page (§3.3).
The waitlist page also drops the `:own` filter that F-09 added to the API, so a
PROVIDER sees the organization's whole waitlist through the page (P4).

### 3.6 Defect C: two live U-05-class escalations (production, today)

- **`sendNowAction`** authorizes `booking.update` with `{ organizationId }`
  only, then calls `sendNowForSession(session, appointmentId)`, which checks
  only that the appointment is in the organization
  (`lib/messaging/reminders.ts:525-533`). A PROVIDER can trigger customer
  reminders for **any** appointment. The API sibling was fixed in U-05 and this
  one was not.
- **`setAvailabilityAction`** authorizes `staff.schedule.manage` with
  `{ organizationId }` only, then rewrites the windows of **any** staff id. A
  PROVIDER can rewrite a colleague's schedule, which opens or closes booking time. The
  API sibling resolves the owner and refuses with 403.

Both are reachable by any signed-in PROVIDER. PROVIDER is an invitable role in
production. Both are independent of every open design decision.

### 3.7 Defect D: vacuous branch tests

- `tests/branch-scoping.test.ts:128-138` and `tests/security-review.test.ts:231-244`
  (P1.6) assert "out-of-scope `locationId` → 400" with a **2020→2100** range.
  `parseAppointmentRange` runs first (`app/api/appointments/route.ts:34`) and
  rejects any span over 62 days. **An in-scope `locationId` returns the same
  400** (P2). Both tests pass whether branch scoping exists or not.
- `tests/branch-scoping.test.ts:103-124, 142-153` assert "no leakage" by
  looping over the result, but the Split fixture has **one location, no
  appointments and no waitlist rows** (`prisma/rbac-fixtures.ts:148-198`), so
  the loops assert nothing (the comment at `:120` says so).

These tests will be strengthened, not removed or weakened.

### 3.8 Unscoped by design and left as-is (recorded)

- `booking.create` is scope-less. Spec §6.2 grants create ✅ (not 🏢) to
  BRANCH_MANAGER and FRONT_DESK, so a branch-scoped user can create in any
  branch.
- `payment.charge` is scope-less. Spec §6.2 grants accept payment ✅ (not 🏢).
- `report.branch` (analytics) is a scope-less **key**, so `can()` cannot
  branch-evaluate it. None of its branch-scoped holders is assignable in production.
  Latent.

---

## 4. Runtime evidence (local DB, real fixture ids)

A throwaway probe run against the **local** database (host verified as
localhost; the probe was never committed) produced the following. Every
synthetic row was deleted by exact id afterwards, and a follow-up check
confirmed zero residue and the P6 target restored to its original 5 windows.

| Probe | Observation |
|---|---|
| **P1** id space | BRANCH_MANAGER `branchIds = {a1f7…(Downtown), daba…}`. Real appointment at Downtown's location, resolved by the real `resolveAppointmentResource()`: `branchId = bbca…` (the **location** id). `can(booking.update)` = **false**. The same context with `branchId = a1f7…` gives **true**. |
| **P2** vacuous 400 | **In-scope** `locationId`, 2020→2100 → `400 {"error":"range must not exceed 62 days (asked for 29220)"}` |
| **P3** empty set | FRONT_DESK `branchIds.size = 0`, `scopedLocationIds = null`. `GET /api/appointments` → 200, **7 rows across both locations (4 + 3)** |
| **P4** waitlist page | PROVIDER, another staff member's waitlist row: page path **true**, API path **false** |
| **P5** `sendNowAction` | Its list-mode gate passes for the PROVIDER. The API route on the same appointment → **403** |
| **P6** `setAvailabilityAction` | API route → **403**. The action **rewrote another staff member's schedule (5 windows → 1)**, and the audit row shows the PROVIDER as actor. (The action then returned a generic error from `revalidatePath` outside a request context. That is a harness artifact after the write had committed.) |
| **P7** waitlist DELETE | BRANCH_MANAGER, row in a branch outside their set → **200, row deleted** |

---

## 5. Consequences for the agreed design

**Unchanged:** the three-state concrete rule, FRONT_DESK as the role that
exercises `booking.update:branch`, BRANCH_MANAGER not invitable, the U-05
three-state `ownerUserId` contract, owner/admin-controlled linking and branch
assignment, and audit of every link, unlink, assign and remove.

**Changed, as the review brief sanctions:** staff cardinality becomes
`(location_id, user_id)` instead of `(organization_id, user_id)` (§2.5).

**Required for the agreed rule to be true in production.** These fix defects
rather than change the design:

1. **Branch id space.** Resolvers put the **branch** id of the resource's
   location in `resource.branchId` (one join through
   `locations.branch`), so the membership test compares like with like.
2. **Grant-aware list filter.** `scopedLocationIds(ctx, basePermission)`:
   `:org` → no filter; `:branch` → the caller's branch locations, where **an empty set
   gives `[]` and therefore zero rows**; `:own` → no branch filter (`scopedByOwn`
   restricts); no grant → `[]`. Applied on every list path in §3.3, including
   the three that filter nothing today.
3. **A resolved but unbranched resource denies `:branch`.** This is the exact
   mirror of U-05. A resolver that looked and found no branch passes
   `branchId: null`, and `can()` treats `null` as deny for `:branch`. Absent
   still means list mode. (Appointments always resolve a branch. This matters for
   the waitlist, see D2.)
4. **Every concrete operation names its resource**: the waitlist DELETE,
   send-now route and action, availability route and action, and the slot lookup.

---

## 6. Owner decisions (answered 2026-09-28)

- **D1: initial branch set for FRONT_DESK → all current branches, then
  narrow.** The migration backfills every existing FRONT_DESK membership with
  all of its organization's current branches. Accepting a receptionist
  invitation, or changing a member's role to receptionist, writes the same
  assignment, and every assignment is audited. Admins narrow the set in
  Members. Branches created later are **not** added automatically, and an empty
  set always denies.
- **D2: waitlist branch attribution → derive, else org-level.** A row's
  branch is its `location_id`, else its staff member's location, else its
  service's location. A row with none of these is org-level: only callers with
  `:org` can list or change it. Under this rule "only assigned-branch rows"
  holds with no exception.
- **D3: the two live escalations (§3.6) → a separate hotfix PR first.** The
  hotfix makes `sendNowAction` and `setAvailabilityAction` resolve their
  concrete resource before authorizing, exactly as their API siblings do. The
  `:branch` dimension for those four call sites comes with the scoped-RBAC
  change, because it depends on the id-space fix (§5.1).

## 7. Recorded, not addressed here

- The reminder template and lead-hours actions are gated by `booking.update` in list mode,
  so any PROVIDER or FRONT_DESK can change organization-wide reminder templates
  and lead time. `saveLeadHoursAction` writes no audit row
  (`components/reminders/actions.ts:55-79`).
- The location switcher lists every location to every member
  (`lib/active-location.ts`). Once scoping is enforced, an out-of-scope location
  renders empty rather than hidden. This is a UX follow-up.
- Cross-location double-booking of one person (§2.6).
- `tests/scheduler-resource-scope.test.ts` said the Server Action and API
  paths "are exercised in tests/scheduler-actions-authz.test.ts". That file
  never existed. The header now names the real coverage.

## 8. Implementation (2026-09-29)

Built exactly the design in §5, with the owner decisions in §6.

| Part | Where |
|---|---|
| Three-state `branchId`; empty set denies concrete | `lib/rbac/types.ts`, `lib/rbac/can.ts` 4b |
| Grant-aware list filter (`[]` for an empty set) | `lib/rbac/scope.ts::scopedLocationIds(ctx, base)` |
| Branch-id resolvers, owner and branch from one row | `resolveAppointmentResource`, `resolveStaffResource`, `resolveWaitlistResource` |
| D2 waitlist attribution, list and resolver | `waitlistInLocations`, `resolveWaitlistResource` |
| Every list path scoped | appointments API, `/scheduler`, waitlist API and page (`waitlistScopeFor`; `listWaitlist` now REQUIRES a scope), `/reminders` (upcoming and log), `/billing` |
| Every concrete path names its resource | appointment PATCH and action, reschedule, waitlist DELETE, send-now route and action, availability route and action, slot lookup |
| Staff link / unlink; member branches | `lib/admin/scoped-access.ts`, Settings → Staff and Members; `staff.role.assign` + rank guardrails, audited, session bump on branch change |
| D1 defaults | migration backfill; `acceptInvitation`; `updateMemberRole` into FRONT_DESK |
| Database guards | `20260929000001_scoped_rbac_links`: `staff_location_user_unique`, `staff_user_is_member`, `membership_branches_same_org`; invariant check 8 |

**Migration gate** (disposable local database brought to the exact
predecessor state with `prisma migrate deploy`, production-shaped fixtures):
32/32. It covers:
- the backfill result per membership shape;
- drift at exit 0 before and after the migration;
- every guard exercised, including one provider linked at two locations of one
  organisation;
- the full invariant script passing;
- the written rollback;
- two abort paths that fail for their stated reason and leave no partial state.

The gate found one defect, now fixed: inside an explicit `BEGIN … COMMIT`,
Prisma swallowed the refusal message. The migration is therefore a single DO
statement.

**Perturbation.** Each control was removed and the suite went red:
- old empty-set semantics → 9 failing cases;
- old location-id resolver → 3;
- unscoped `/waitlist` page → 2.

Invariant check 8 has six injected-failure tests; each breaks the database,
sees the verifier refuse, restores it, and sees it pass.

Still to do after merge: deploy, confirm the migration and invariants in
production, and rerun C7 with synthetic users through the product flows.
