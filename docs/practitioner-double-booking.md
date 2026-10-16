# Cross-location double-booking — one practitioner, one place at a time

**Backlog item A** (post-release, 2026-10-17). Migration
`20261017000001_practitioner_double_booking`. Its header carries the full
rationale; this page records the decision, the release-gate steps and the
evidence.

## The defect

A practitioner who works at two locations of one organisation is two `staff`
rows, both linked to their account through `staff.user_id`
(`docs/scoped-rbac-assumption-audit.md` §2). The only double-booking guard,
`no_staff_double_booking`, is a GiST exclusion on `(staff_id, tstzrange)` and is
keyed on the **row**. So the same person could be booked at 10:00 at location A
and at 10:00 at location B. The scoped-RBAC audit (§2.6) recorded this as a known
gap, and so did the certified release's non-blocking list.

## The invariant, as enforced

> No two active (non-cancelled) bookings of one practitioner overlap. A
> practitioner is a user, across every staff row linked to them, **within one
> organisation**.

| Question | Answer |
|---|---|
| Who is "the same practitioner"? | Staff rows linked to the same `user_id`. Unlinked rows are not matched by name or email: linking is the act that declares identity. |
| Across organisations? | No. Refusing a booking in org A because of org B's calendar would disclose B's schedule to A. Both are independent calendars. |
| What overlaps? | Half-open `[starts_at, ends_at)`, exactly like `tstzrange` in the existing constraint, so back-to-back bookings are fine. Instants are absolute, so time zones cannot cause a false clash. |
| What blocks? | Any status except `cancelled`, the same rule as `no_staff_double_booking`. |
| When is it decided? | On insert, and on an update that changes WHO (`staff_id`), WHEN (`starts_at`, `ends_at`), or reactivates a cancelled booking. A notes or payment edit never re-decides. |
| Linking? | Linking a staff row is refused while one of its upcoming bookings overlaps one of the practitioner's. Past overlaps do not block a link: they cannot be repaired by refusing it, and refusing it forever would strand the bookings unowned. |
| Existing data? | Not rewritten and not validated retroactively. Invariant check 9 reports any **upcoming** overlap. |

## Why a trigger and not a constraint

An exclusion constraint can only compare columns of one table, and the identity
lives on `staff`. Denormalising `user_id` onto `appointments` would make linking
rewrite booking rows, and would have to fail on historical overlaps. Instead:

- `appointments_practitioner_no_overlap` (BEFORE INSERT/UPDATE): reads the row's
  practitioner `FOR SHARE`, takes `pg_advisory_xact_lock(org, practitioner)` held
  to commit, then looks for a clash on the practitioner's other rows.
- `staff_link_no_practitioner_overlap` (BEFORE UPDATE OF `user_id`): same lock,
  checks the row's upcoming bookings against the practitioner's.
- Both raise `23P01` naming `no_practitioner_double_booking`. They reach the
  application as Prisma `P2039` with "exclusion constraint" in the message, the
  shape `isExclusionViolation` already classifies, so every write path answers
  **409 `slot_taken`** with no code change. The staff-link path now maps it to a
  `ConflictError`, where it used to surface as a 500.
- Under READ COMMITTED (the default; nothing sets another level) the decision
  that waits on the lock sees what the previous holder committed. Under
  REPEATABLE READ it could not, so the trigger refuses (`55000`) rather than
  deciding on a stale snapshot.

The slot picker (`getAvailableSlots`) hides the practitioner's bookings on their
other rows too, so it does not offer times the write path will refuse. It looks
in the same organisation only. A branch-scoped user therefore sees a time at
their branch as busy without seeing why. That is the minimum disclosure that
preventing the double-booking requires.

## Release gate — before applying

Read-only preflight against production. A non-zero count is a real person booked
in two places, and should be resolved with the organisation first. Invariant
check 9 enforces the same condition afterwards.

```sql
SELECT count(*) AS upcoming_cross_row_overlaps
  FROM appointments a
  JOIN staff sa ON sa.id = a.staff_id AND sa.user_id IS NOT NULL
  JOIN appointments b ON b.organization_id = a.organization_id
                     AND b.id > a.id AND b.staff_id <> a.staff_id
                     AND b.status <> 'cancelled'
                     AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
  JOIN staff sb ON sb.id = b.staff_id AND sb.user_id = sa.user_id
 WHERE a.status <> 'cancelled' AND (a.ends_at > now() OR b.ends_at > now());
```

Rollback is in the migration header. It must delete the `_prisma_migrations` row
in the same transaction. `prisma migrate resolve --rolled-back` refuses a
migration that succeeded (P3012, measured), and dropping only the objects leaves
the guard gone while the ledger still says "applied".

## Evidence (local, 2026-10-17)

| Gate | Result |
|---|---|
| Applied from the **true predecessor** (a database built from `origin/main`'s 74 migrations, then seeded) | applied |
| Abort path (5 s `lock_timeout` while `appointments` is locked) | `P3018` / `55P03` "canceling statement due to lock timeout" in the deploy log. **0** functions or triggers left behind. `resolve --rolled-back` then re-deploy succeeds |
| Written rollback | schema dump **byte-identical** to the predecessor's. The double-booking is possible again. A later deploy re-applies cleanly |
| `prisma migrate diff --from-migrations … --exit-code` (CI's strict drift check) | exit 0. A perturbed schema gives exit 2 |
| `tests/practitioner-double-booking.test.ts` | 27/27 |
| `tests/production-invariants.test.ts` (with check 9) | 52/52 on a fresh seeded database |

Perturbations. Each control was switched off, and the count of tests that went red:

| Control removed | Red |
|---|---|
| booking trigger disabled | 13 |
| link trigger disabled | 1 |
| picker reverted to the single row | 1 |
| link path's `ConflictError` mapping removed | 1 (a raw Prisma error, i.e. a 500) |
| verifier check 9c disabled | 1 |
