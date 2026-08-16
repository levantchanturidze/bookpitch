# Phase 2 — Migration Runbook

Executing this document rolls production forward to the new RBAC model. It
assumes you have not read the surrounding design docs and are running it at
3am. Every command is copy-pasteable.

**Read first, execute second.** The window is short (est. <5 minutes for the
whole apply on current prod volumes), but a misordered step costs more than a
careful read.

Design context lives in `docs/rbac-spec.md`, `docs/rbac-discovery.md`, and
`docs/rbac-schema-notes.md`. Do not re-derive it from the migration files.

---

## What this migration does

- Backfills the Phase 1 columns for every existing row
  (`organizations.vertical/owner_user_id`, `branches` from `locations`,
  `memberships.role_id/joined_at/is_bookable`, `app_users.platform_role_id`
  for the SUPER_ADMIN account).
- Installs DB triggers that keep those columns in sync when the application
  writes to the OLD shape after cutover (removed in Phase 4).

Both changes are shipped as two Prisma migrations. Both are applied by a
single `apply` command below.

## Blast radius

- **Writes**: `organizations`, `branches` (new rows), `memberships`,
  `app_users` (one row).
- **Reads**: none disturbed. Existing app code doesn't read the new columns
  yet.
- **Downtime required**: yes, but only a minute or two — see step 3.
- **Cutover cost**: nobody has to re-login.

Prod today (Phase 0 §9): 2 users, 1 org, 0 customers, 0 appointments.

---

## Pre-flight — do this the day before

Run each command; do not skip on the assumption that yesterday's answer is
still valid.

1. **PITR window intact.** *(No longer applicable — 2026-08-16.)* This project
   is on Supabase **Free**, which has neither PITR nor automated backups; the
   `verify-pitr.sh` check it referred to could never have passed and has been
   removed. The recovery point is the daily logical backup instead, so the
   pre-flight requirement is now step 2: there must be a **fresh** backup, not
   yesterday's. See `docs/operations.md` §11 for the resulting RPO.

2. **Manual encrypted snapshot.** This is the last known good for the runbook.
   ```
   gh workflow run production-backup.yml
   gh run watch "$(gh run list --workflow=production-backup.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```
   Note the run id. Do not proceed until the run is green, including its
   `verify` job.

3. **Restore that snapshot to a scratch DB and dry-run against it.** This
   is the only way to know the migration behaves on real prod data.
   ```
   gh workflow run restore-drill.yml -f backup_run_id=<run-id-from-step-2>
   # for a hands-on scratch DB, follow docs/operations.md §6 to decrypt the
   # artifact and restore it into a database you created for the purpose
   # then, pointing ADMIN_DATABASE_URL at the restored DB:
   ADMIN_DATABASE_URL='postgresql://...restored...' npx tsx scripts/rbac-backfill.ts dry-run
   ADMIN_DATABASE_URL='postgresql://...restored...' npx tsx scripts/rbac-backfill.ts apply
   ADMIN_DATABASE_URL='postgresql://...restored...' npx tsx scripts/rbac-backfill.ts verify
   ```
   All three must succeed on the scratch DB before touching prod.

4. **Migrations are pending on prod, not applied.** Confirm Phase 2's two
   migrations are NOT in `_prisma_migrations` yet:
   ```
   psql "$ADMIN_DATABASE_URL" -c "SELECT migration_name FROM _prisma_migrations WHERE migration_name LIKE '%rbac_backfill%' OR migration_name LIKE '%rbac_sync_triggers%';"
   ```
   Expect zero rows. If either name appears, someone already ran Phase 2 —
   stop and investigate before doing anything else.

---

## Cutover window

Est. duration: 2–5 minutes wall clock. The transactional migration is
sub-second on current volumes; the rest is human coordination.

### Step 1. Announce maintenance

Post in `#status` (or wherever the on-call channel is) something concrete:
"RBAC Phase 2 migration starts at HH:MM, expected ≤10 min, no impact on
existing bookings." Then wait until HH:MM before touching anything.

### Step 2. Take a fresh snapshot

```
gh workflow run production-backup.yml
```

A different run from pre-flight. Note the run id in the incident channel.

### Step 3. Put the app in maintenance mode

Set the Vercel env flag `MAINTENANCE_MODE=1` (or whatever the current
project uses — check `proxy.ts` for the exact env-var name). Redeploy or
wait for the runtime to pick it up. Confirm by hitting the app URL —
expect the maintenance page, not a 200.

**Why:** while the migration runs, any concurrent write to `memberships`,
`organizations`, or `locations` would either block on the row lock or land
in the DB after the backfill finished but before the sync triggers were
armed. The maintenance flag removes that class of race.

### Step 4. Dry-run against prod

```
npx tsx scripts/rbac-backfill.ts dry-run
```

Read the output line by line. Sanity check:
- **Step 1 (vertical to fill)**: ≥1 per org that has any locations.
- **Step 2 (branches to create)**: exactly one per row of `SELECT count(*)
  FROM locations`.
- **Step 3 (owner to fill)**: ≥1 per active org.
- **Steps 4–6**: sum to the row count of `memberships`.
- **Step 7 (SUPER_ADMIN seed)**: 1 if `levaaani@gmail.com` exists in prod,
  0 if not. Zero here is fine — see step 8 below.

If any number looks wrong, **stop.** Do not proceed to apply. Investigate.

### Step 5. Apply

```
npx tsx scripts/rbac-backfill.ts apply
```

This runs `prisma migrate deploy` for both Phase 2 migrations, then
automatically runs verify. Expected tail:

```
=== Phase 2 backfill — verify ===
  [PASS] A. every active app_user has ≥1 active membership OR is platform-plane  (n=0)
  [PASS] B. every non-archived organization has owner_user_id set  (n=0)
  [PASS] C. every non-archived organization has ≥1 active ORG_OWNER membership  (n=0)
  [PASS] D. every location has exactly one branch (legacy_location_id 1:1)  (n=0)
  [PASS] E. no memberships with role set but role_id NULL  (n=0)
  [PASS] F. enum→key mapping holds (owner=ORG_OWNER)  (n=0)
  [PASS] G. enum→key mapping holds (practitioner=PROVIDER)  (n=0)
  [PASS] H. enum→key mapping holds (receptionist=FRONT_DESK)  (n=0)
  [PASS] I. no is_bookable=true where role NOT IN (owner, practitioner)  (n=0)
  [PASS] J. no orphan branches (legacy_location_id points at deleted loc)  (n=0)

All checks passed.
```

Exit code 0. If any check FAILs, go to Rollback (below).

### Step 6. Spot-check with psql

Verify by hand — do not trust the script blindly. Copy each block whole:

```sql
-- One row per org, each with a vertical + owner set.
SELECT id, name, vertical, owner_user_id FROM organizations;

-- One row per (memberships.role, roles.key) pair, all mappings correct.
SELECT m.role, r.key, count(*)
  FROM memberships m JOIN roles r ON r.id = m.role_id
 GROUP BY 1, 2 ORDER BY 1;

-- branches count matches locations count exactly.
SELECT (SELECT count(*) FROM locations) AS locations,
       (SELECT count(*) FROM branches WHERE legacy_location_id IS NOT NULL) AS branches;
```

If any block returns something surprising, go to Rollback.

### Step 7. Lift maintenance mode

Unset `MAINTENANCE_MODE`, redeploy (or wait). Confirm the app serves a
normal page.

Post in `#status`: "Migration complete, maintenance lifted." Include the
final verify output for the incident-channel record.

### Step 8. (If Step 4 showed 0 for SUPER_ADMIN seed) — grant it manually later

The `levaaani@gmail.com` app_user row doesn't exist yet in prod (the local
dev environment happens to have different seed users). When that account
first signs up, or if you want to grant SUPER_ADMIN to a different email,
run:

```sql
UPDATE app_users
   SET platform_role_id = (SELECT id FROM roles WHERE key='SUPER_ADMIN' AND organization_id IS NULL),
       mfa_enabled = TRUE
 WHERE email = 'levaaani@gmail.com';   -- swap for the real address
```

This is idempotent (row is unaffected on re-run). Log this in the incident
channel when it happens.

---

## Rollback

Cheap. Run at any time; the sync-triggers rollback comes first so the
next writes don't immediately re-fill the columns we're about to clear.

```
npx tsx scripts/rbac-backfill.ts rollback
```

Expected output:

```
=== Phase 2 backfill — rollback ===

> 20260728000100_rbac_sync_triggers/down.sql
  applied, migration row removed

> 20260728000000_rbac_backfill/down.sql
  applied, migration row removed

Rollback complete. Run `apply` to re-run the forward migration.
```

After rollback, the DB is byte-identical to its pre-Phase-2 state as far as
the app is concerned: new columns are NULL, backfilled branches are gone,
sync triggers are dropped. Prisma will list both migrations as pending again
on the next `migrate deploy`.

If the app is already back up when you rollback, keep maintenance mode ON
until Phase 2 is either re-applied or explicitly retired. The old columns
are still authoritative during rollback; the app is fine, but you don't
want a new signup mid-triage.

---

## Failure modes

### Apply fails mid-migration

Prisma wraps each migration in a transaction. If anything raises before
`COMMIT`, Postgres rolls back the whole migration and `_prisma_migrations`
does not record it. **Do this:** re-read the error, fix the cause (usually
a data-shape assumption in the SQL), and run `apply` again. The forward
migration is idempotent.

If you get a partial-apply state (one migration recorded, the other not),
rollback — it will safely no-op the missing steps and unrecord the applied
one.

### Verify fails after apply

The migration applied cleanly but an invariant check reports a non-zero
row count. Common causes:

- **B/C failed**: an org exists with no owner membership. This should have
  been surfaced by the Phase 0 discovery (`orgs_without_owner: 0` at that
  time). If it's non-zero now, someone deleted the last owner between then
  and cutover. Rollback, investigate the org's history, decide whether to
  fix by manual insert or exclude the org before re-applying.
- **D failed**: `locations` and `branches` counts don't match. Either a
  legacy_location_id got NULLed (someone deleted a location during the
  window — see maintenance flag) or the trigger crashed. Rollback and
  redo the pre-flight snapshot restore drill; something is off.
- **F/G/H failed**: enum→key mapping mismatch. Almost always means the
  seed didn't run and the `roles` table is missing rows. Run `npx tsx
  prisma/rbac-seed.ts` and re-verify. If the seed is fine, rollback and
  investigate — this is a real bug and should not ship.

### App broke after cutover

The most likely cause is a lingering write path that wasn't in the sync
trigger's coverage. Symptoms: a new signup creates a `memberships` row
with `role_id IS NULL`, or a new location doesn't get a matching branch.

- Confirm: run `verify` again. Check E and D.
- If E or D is non-zero, don't rollback — the OLD columns still work.
  Instead, run the SQL from `20260728000000_rbac_backfill/migration.sql`
  by hand (it's idempotent — see the `WHERE new_col IS NULL` guards) to
  catch up any drift, and file a bug for the missing sync-trigger case.

### The DB is a mess and I need to start over

Restore from the pre-flight snapshot. There is deliberately **no automation**
for restoring into production — follow `docs/operations.md` §6 "Real recovery
into production", which restores into a *new* database and repoints the
application, rather than writing over the live one.

The end state is prod running the pre-migration data. Do not do this without
confirming in the incident channel first — anything committed to prod
after the snapshot is lost.

---

## What Phase 2 does NOT do

Do not expect any of the following. Reach for the phase that owns them.

- Change what the application reads or writes. Phase 4 does this.
- Drop the `memberships.role` enum or the `locations` table. Contract does
  this, months from now.
- Enforce spec invariants like "≥1 active ORG_OWNER" at write time. Phase
  6 does this. Phase 2 only verifies the invariant is true today; it does
  not stop tomorrow's `admin.ts::removeMember` from breaking it.
- Wire up SUPER_ADMIN's break-glass UI. Phase 5.
