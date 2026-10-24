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

## Release gate

### Merging this PR is the production migration

`migrate.yml` runs on any push to `main` touching `prisma/migrations/**` or
`scripts/verify-production-invariants.sql`, and this PR touches both. On the
merge push, in order, against production (`DATABASE_URL_SUPERUSER_MIGRATE`):

1. `prisma migrate status` (informational) and the availability backfill
   preflight (read-only).
2. **The practitioner double-booking preflight** (read-only, counts only;
   below). It never stops the apply.
3. `prisma migrate deploy`: this migration, one `DO` block with a 5 s
   `lock_timeout` and a 60 s `statement_timeout`. CREATE FUNCTION and CREATE
   TRIGGER only; no row is read or written.
4. The ledger check, the read-only drift check, and the invariant verifier,
   whose **check 9** requires both triggers to exist and to *fire for the
   application* (`tgenabled` `O` or `A`; disabled `D` and replica-only `R` both
   fail), and no upcoming cross-row overlap (9c).
5. On any failure: an `[urgent] Migration workflow failed` issue, assigned to
   the owner.

Vercel deploys the same push **in parallel**, so the order of code and schema
is not guaranteed. Both orders are safe, and that is why this is expand-only:

| Running | Behaviour |
|---|---|
| New code, schema without the triggers | as today: a cross-row double-booking is still possible. The picker already hides the practitioner's other bookings, so it offers fewer times, which is harmless. The link `ConflictError` mapping is simply never triggered |
| Old code, schema with the triggers | the guard refuses with `23P01`, which every write path on `main` already answers as **409 `slot_taken`** (verified per path in `tests/practitioner-double-booking.test.ts`). Only the staff-link path would show a raw error, a 500 instead of a 409, until the new code is live |

### Before merging: the preflight (owner-operated, read-only)

Run `scripts/practitioner-double-booking-preflight.sql` against production with
**`psql -f`**, from a checkout of this branch. It needs the superuser connection
string that `migrate.yml` uses (`DATABASE_URL_SUPERUSER_MIGRATE`).

1. Read the connection string into a variable without echoing it, so it never
   lands in shell history or on screen, then run the script:

   ```bash
   read -rs PGURL && export PGURL          # paste the URL, press Enter
   psql "$PGURL" -X -q -v ON_ERROR_STOP=1 -At -F '|' \
     -f scripts/practitioner-double-booking-preflight.sql
   unset PGURL
   ```

2. Expected output **before the migration has applied**, line by line:

   ```
   === practitioner double-booking preflight (counts only) ===
   0
   <n>
   0|0|0|PASS: nobody is booked in two places
   ```

   | Line | Meaning |
   |---|---|
   | `0` | guard triggers present. **0** before the migration, **2** after it |
   | `<n>` | people with more than one staff row in one organisation. Context only; any value is fine |
   | `0\|0\|0\|PASS…` | the verdict: upcoming overlapping pairs, practitioners affected, organisations affected |

   Verified on 2026-10-25 against a database at the predecessor's 74 migrations
   (production's state before this merge). The command above printed exactly
   these four lines, with `<n>` = 0. Without `-q`, psql also prints a `SET`
   command tag for each of the two session settings.

3. **Not in the Supabase SQL editor.** The script uses psql meta-commands
   (`\set ON_ERROR_STOP on`, `\echo`) that a web SQL editor rejects as syntax
   errors. Its read-only pin (`SET default_transaction_read_only = on`) also
   binds only later transactions, which a single-request editor run may not
   give. `psql -f` gives both.

4. **It is read-only:**
   - the session is pinned read-only before the first query, and an appended
     `DELETE` is refused (`tests/production-invariants.test.ts`);
   - the script contains no write statement (`tests/workflow-safety.test.ts`);
   - it prints counts only: no identifier, name or time;
   - it stops after 60 seconds (`statement_timeout`).

5. **If the verdict is not PASS, do not merge yet.** Each pair is a real person
   booked in two places at once, which the organisation has to resolve: one
   booking moved or cancelled, through the product. Then re-run the preflight.
   Merging anyway installs the guard, which is good, but check 9c then fails
   the deploy verification. The overlap is not created by the migration; it is
   reported by it.

6. **If psql errors** (connection refused, authentication, the 60-second
   timeout), nothing was read or written. Re-run later. Do not merge without a
   recorded PASS.

7. **Record** the date and time (UTC) and the verdict line on this pull request
   before merging.

### If something goes wrong

| What happened | What it means | Do this |
|---|---|---|
| The apply aborts: `P3018` / `55P03` "canceling statement due to lock timeout" | `appointments` or `staff` was locked for 5 s. **Nothing was created** (proven: 0 functions or triggers left). Prisma records the migration as failed and refuses further deploys (P3009) | `npx prisma migrate resolve --rolled-back 20261017000001_practitioner_double_booking` against production, then re-run `migrate.yml` (workflow_dispatch) at a quieter time |
| The apply succeeds, and the verifier fails on **9c** | Someone was already booked in two places; the preflight was skipped or the data changed since | **Do not roll back**: the guard is what prevents new ones. Resolve the pair with the organisation, then re-run `migrate.yml` for a green verification |
| The verifier fails on **9a/9b** (missing, disabled or replica-only) | The guard is not firing | `ALTER TABLE appointments ENABLE TRIGGER appointments_practitioner_no_overlap` (or the `staff` one). Find out what changed it before re-running the verifier |
| Legitimate bookings are refused (a defect in the trigger) | The guard itself is wrong | **Two steps, in this order.** (1) Run the rollback in the migration header, in one transaction. It drops both triggers and functions **and deletes the `_prisma_migrations` row**. `prisma migrate resolve --rolled-back` is refused for a migration that succeeded (P3012, measured), and dropping only the objects leaves the ledger saying "applied". (2) Merge a revert of this PR. Until that revert lands, the migration file is still in the repository with no ledger row, so the next `migrate.yml` run would **re-apply it** |

The rollback was proven on a disposable database: the schema dump after it is
byte-identical to the predecessor's, and a later deploy re-applies cleanly. It
loses no data, because the migration wrote none. What it gives back is the
defect: a cross-row double-booking becomes possible again.

## Evidence (local, 2026-10-17)

| Gate | Result |
|---|---|
| Applied from the **true predecessor** (a database built from `origin/main`'s 74 migrations, then seeded) | applied |
| Abort path (5 s `lock_timeout` while `appointments` is locked) | `P3018` / `55P03` "canceling statement due to lock timeout" in the deploy log. **0** functions or triggers left behind. `resolve --rolled-back` then re-deploy succeeds |
| Written rollback | schema dump **byte-identical** to the predecessor's. The double-booking is possible again. A later deploy re-applies cleanly |
| `prisma migrate diff --from-migrations … --exit-code` (CI's strict drift check) | exit 0. A perturbed schema gives exit 2 |
| `tests/practitioner-double-booking.test.ts` | 27/27 |
| `tests/production-invariants.test.ts` (with check 9) | 52/52 on a fresh seeded database (2026-10-17); **58/58** with the 2026-10-18 additions below |
| Check 9 and replica-only triggers (Codex review, 2026-10-18) | `ENABLE REPLICA TRIGGER` on either trigger fails check 9 ("enabled for replica sessions only"); `ENABLE ALWAYS` passes |
| Preflight (2026-10-18), on the same database | clean: `0\|0\|0\|PASS`; with an injected overlap: `1\|1\|1\|RESOLVE FIRST`, with no UUID or fixture name in the output; an appended `DELETE` refused as read-only |

Perturbations. Each control was switched off, and the count of tests that went red:

| Control removed | Red |
|---|---|
| booking trigger disabled | 13 |
| link trigger disabled | 1 |
| picker reverted to the single row | 1 |
| link path's `ConflictError` mapping removed | 1 (a raw Prisma error, i.e. a 500) |
| verifier check 9c disabled | 1 |
| check 9 back to `= 'D'` (replica-only accepted) | 2 |
| preflight read-only pin removed | 1 |
| preflight predicate made blind (`WHERE false`) | 1 |
