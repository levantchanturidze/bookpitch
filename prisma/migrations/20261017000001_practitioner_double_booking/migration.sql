-- =============================================================================
-- One practitioner, one place at a time — across every staff row they hold.
--
-- `no_staff_double_booking` (init migration) is a GiST exclusion on
-- (staff_id, tstzrange(starts_at, ends_at)). It is keyed on the staff ROW, and
-- a practitioner who works at two locations of one organisation is two staff
-- rows: staff.location_id is a single NOT NULL column, availability has no
-- location, and booking requires staff.location_id = appointment.location_id
-- (docs/scoped-rbac-assumption-audit.md §2). Since C7 both rows can be linked
-- to the practitioner's account through staff.user_id — and the constraint
-- still saw two different staff ids, so the same person could be booked at
-- 10:00 at location A and at 10:00 at location B. Recorded as a known,
-- pre-existing limitation in that audit (§2.6) and in the certified release's
-- non-blocking list.
--
-- WHAT THIS ADDS
--
-- 1. appointments_practitioner_no_overlap — BEFORE INSERT/UPDATE on
--    appointments. When the row's staff member is linked to a user, it refuses
--    an active (non-cancelled) booking that overlaps an active booking held by
--    ANY OTHER staff row linked to the same user in the same organisation.
--    Same-row overlaps stay with no_staff_double_booking, unchanged.
--
-- 2. staff_link_no_practitioner_overlap — BEFORE UPDATE OF user_id on staff.
--    Linking a staff row to a practitioner refuses when one of that row's
--    UPCOMING active bookings overlaps one of the practitioner's other active
--    bookings. Without it, linking would be a way around (1): book first at the
--    unlinked row, link afterwards.
--
-- Both raise SQLSTATE 23P01 (exclusion_violation) naming
-- "no_practitioner_double_booking", so every write path that already maps the
-- per-row constraint to 409 slot_taken (lib/appointments.ts
-- isExclusionViolation) maps this one too.
--
-- IDENTITY. staff.user_id is the only identity the model has for "the same
-- person". Two UNLINKED rows that are in fact one person cannot be told apart
-- from two people, and are not guessed at (no matching on name or email).
-- Linking is the act that declares identity; Settings → Staff does it.
--
-- TENANT ISOLATION. Every lookup is filtered by NEW.organization_id. A
-- practitioner who is a member of two organisations is two independent
-- calendars: refusing a booking in one organisation because of the other would
-- disclose the other tenant's schedule, so it is deliberately not done.
--
-- CONCURRENCY. An exclusion constraint cannot express this (it can only compare
-- columns of one table), so the decision is serialised instead:
--   • pg_advisory_xact_lock on (organisation, practitioner) — held to commit, so
--     two bookings for one practitioner decide one after the other, and under
--     READ COMMITTED (the default; no code path sets another level) the second
--     decision's query takes a snapshot after the first has committed;
--   • SELECT … FOR SHARE on the staff row — a concurrent link or unlink of that
--     row waits for the booking (or the booking waits for it), so the identity
--     a decision rests on cannot change underneath it.
--   REPEATABLE READ would defeat the lock (the snapshot predates the wait), so
--   the function refuses to run under it rather than deciding on a stale view.
--   SERIALIZABLE is safe: SSI aborts one of two conflicting deciders.
--
-- WHAT RE-DECIDES ON UPDATE. Only a change of WHO (staff_id) or WHEN (starts_at,
-- ends_at), or a cancelled booking becoming active again. A notes or payment
-- edit on a booking never re-decides, so it cannot fail on an overlap that
-- predates this migration.
--
-- EXISTING DATA. Nothing is rewritten and nothing is validated retroactively:
-- the triggers decide new writes only, and the link check looks at upcoming
-- bookings only (a past overlap cannot be repaired by refusing a link today, and
-- refusing one forever would strand the practitioner's bookings unowned). Read-
-- only preflight for the release gate, run BEFORE applying:
--
--   SELECT count(*) AS upcoming_cross_row_overlaps
--     FROM appointments a
--     JOIN staff sa ON sa.id = a.staff_id AND sa.user_id IS NOT NULL
--     JOIN appointments b ON b.organization_id = a.organization_id
--                        AND b.id > a.id
--                        AND b.staff_id <> a.staff_id
--                        AND b.status <> 'cancelled'
--                        AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
--     JOIN staff sb ON sb.id = b.staff_id AND sb.user_id = sa.user_id
--    WHERE a.status <> 'cancelled' AND a.ends_at > now() AND b.ends_at > now();
--
-- A non-zero count is a real practitioner booked in two places; resolve it with
-- the organisation before applying. Invariant check 9 asserts the same count is
-- zero on every migrate run afterwards.
--
-- LOCKS. CREATE FUNCTION / CREATE TRIGGER take SHARE ROW EXCLUSIVE on the two
-- tables for milliseconds; no row is read or written. Bounded by lock_timeout.
--
-- ONE STATEMENT, NOT BEGIN/COMMIT (see 20260929000001): a single DO block is
-- atomic on its own and keeps any refusal message in the migrate log.
--
-- ROLLBACK (the tested reverse). Roll the APPLICATION back with it or first:
-- the previous verifier has no check 9, and the new code's handling of the
-- error is harmless without the triggers.
--
--   BEGIN;
--   DROP TRIGGER IF EXISTS staff_link_no_practitioner_overlap ON staff;
--   DROP FUNCTION IF EXISTS staff_link_no_practitioner_overlap();
--   DROP TRIGGER IF EXISTS appointments_practitioner_no_overlap ON appointments;
--   DROP FUNCTION IF EXISTS appointments_practitioner_no_overlap();
--   DELETE FROM _prisma_migrations
--    WHERE migration_name = '20261017000001_practitioner_double_booking';
--   COMMIT;
--
-- The ledger row goes in the SAME transaction, and that is not optional.
-- `prisma migrate resolve --rolled-back` refuses a migration that succeeded
-- (P3012, measured), and dropping only the objects leaves the ledger saying
-- "applied": the next deploy reports "No pending migrations" and the guard
-- stays gone for good — silently, except to invariant check 9. Measured on a
-- disposable copy of the predecessor database: after this rollback the schema
-- dump is byte-identical to the predecessor's, and a later deploy re-applies
-- the migration cleanly.
--
-- Rolling back re-opens cross-location double-booking; nothing else depends on
-- these objects.
-- =============================================================================

DO $migration$
BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '60s';

  -- ---------------------------------------------------------------------------
  -- 1. A booking may not overlap the same practitioner's booking on another
  --    staff row.
  -- ---------------------------------------------------------------------------
  CREATE FUNCTION appointments_practitioner_no_overlap() RETURNS trigger AS $fn$
  DECLARE
    practitioner uuid;
    clash        uuid;
  BEGIN
    -- A cancelled booking occupies nobody.
    IF NEW.status = 'cancelled' THEN
      RETURN NEW;
    END IF;

    -- Only WHO, WHEN, or a cancelled booking coming back can create an overlap.
    IF TG_OP = 'UPDATE'
       AND NEW.staff_id  IS NOT DISTINCT FROM OLD.staff_id
       AND NEW.starts_at IS NOT DISTINCT FROM OLD.starts_at
       AND NEW.ends_at   IS NOT DISTINCT FROM OLD.ends_at
       AND OLD.status <> 'cancelled' THEN
      RETURN NEW;
    END IF;

    -- Who is this? FOR SHARE so a concurrent link/unlink of this row cannot
    -- change the answer before this transaction commits.
    SELECT s.user_id INTO practitioner
      FROM staff s
     WHERE s.id = NEW.staff_id
       FOR SHARE;

    -- Unlinked: the row is the only identity there is, and the per-row
    -- exclusion constraint already governs it.
    IF practitioner IS NULL THEN
      RETURN NEW;
    END IF;

    -- From here the decision depends on waiting for the lock and then SEEING
    -- what the previous holder committed, which REPEATABLE READ cannot do.
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION 'appointments_practitioner_no_overlap cannot decide under REPEATABLE READ: '
                      'its snapshot predates the advisory lock it waits on'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      'appointments.practitioner:' || NEW.organization_id::text || ':' || practitioner::text, 0));

    SELECT a.id INTO clash
      FROM appointments a
      JOIN staff s ON s.id = a.staff_id
     WHERE a.organization_id = NEW.organization_id
       AND s.organization_id = NEW.organization_id
       AND s.user_id = practitioner
       AND a.staff_id <> NEW.staff_id
       AND a.id <> NEW.id
       AND a.status <> 'cancelled'
       -- Half-open [starts_at, ends_at), as tstzrange in no_staff_double_booking:
       -- back-to-back bookings do not overlap.
       AND a.starts_at < NEW.ends_at
       AND a.ends_at   > NEW.starts_at
     LIMIT 1;

    IF clash IS NOT NULL THEN
      -- No identifiers in the message: it can reach logs, and the clashing
      -- booking may be in a branch the caller cannot see.
      RAISE EXCEPTION 'conflicting key value violates exclusion constraint "no_practitioner_double_booking"'
        USING ERRCODE    = 'exclusion_violation',
              CONSTRAINT = 'no_practitioner_double_booking',
              DETAIL     = 'The same practitioner already has an active booking at an '
                           'overlapping time under another staff record.';
    END IF;

    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE TRIGGER appointments_practitioner_no_overlap
    BEFORE INSERT OR UPDATE OF staff_id, starts_at, ends_at, status ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_practitioner_no_overlap();

  -- ---------------------------------------------------------------------------
  -- 2. Linking a staff row may not create an upcoming overlap.
  -- ---------------------------------------------------------------------------
  CREATE FUNCTION staff_link_no_practitioner_overlap() RETURNS trigger AS $fn$
  DECLARE
    clash uuid;
  BEGIN
    IF NEW.user_id IS NULL OR NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
      RETURN NEW;
    END IF;

    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION 'staff_link_no_practitioner_overlap cannot decide under REPEATABLE READ: '
                      'its snapshot predates the advisory lock it waits on'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- The same lock the booking trigger takes, so a link and a booking for one
    -- practitioner decide one after the other.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'appointments.practitioner:' || NEW.organization_id::text || ':' || NEW.user_id::text, 0));

    SELECT mine.id INTO clash
      FROM appointments mine
      JOIN appointments theirs
        ON theirs.organization_id = NEW.organization_id
       AND theirs.status <> 'cancelled'
       AND theirs.starts_at < mine.ends_at
       AND theirs.ends_at   > mine.starts_at
      JOIN staff s
        ON s.id = theirs.staff_id
       AND s.organization_id = NEW.organization_id
       AND s.user_id = NEW.user_id
       AND s.id <> NEW.id
     WHERE mine.staff_id = NEW.id
       AND mine.organization_id = NEW.organization_id
       AND mine.status <> 'cancelled'
       -- Upcoming: the overlap itself has not ended, so both bookings end
       -- later. A booking still running past an overlap that is over does not
       -- block the link (Codex review on #112).
       AND mine.ends_at > now()
       AND theirs.ends_at > now()
     LIMIT 1;

    IF clash IS NOT NULL THEN
      RAISE EXCEPTION 'conflicting key value violates exclusion constraint "no_practitioner_double_booking"'
        USING ERRCODE    = 'exclusion_violation',
              CONSTRAINT = 'no_practitioner_double_booking',
              DETAIL     = 'Linking this staff record would book the practitioner twice: one of '
                           'its upcoming bookings overlaps one of theirs under another staff record.';
    END IF;

    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE TRIGGER staff_link_no_practitioner_overlap
    BEFORE UPDATE OF user_id ON staff
    FOR EACH ROW EXECUTE FUNCTION staff_link_no_practitioner_overlap();
END
$migration$;
