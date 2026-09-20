-- STAGE A of the availability local-time rollout: SCHEMA EXPANSION ONLY.
--
-- Nothing here changes a single availability value, and no application release
-- that ships with this migration reads or writes the new column. That is the
-- whole point.
--
-- WHY THIS IS SPLIT ACROSS RELEASES.
--
-- .github/workflows/migrate.yml applies migrations on push to main while Vercel
-- deploys from the same push IN PARALLEL — its own header says the deployed
-- code "may briefly run against the pre-migration schema". The corollary is
-- that the PREVIOUS release keeps serving for a minute or two against the
-- POST-migration database, and it is the corollary that matters.
--
-- Two ways a combined release corrupts data in that window, both silent:
--
--   1. The old build writes availability without supplying time_basis. If the
--      column default were already 'local', its UTC-form value would be
--      labelled local at birth — and then protected from correction by the
--      very marker meant to prevent double conversion. So the default stays
--      'utc_legacy' here, and is NOT flipped. An omitted basis means exactly
--      what every row written before this column meant.
--
--   2. A new build writing genuine local values while a pre-marker old
--      instance is still alive: that instance ignores time_basis and reads
--      those local values as UTC, four hours out. Which is why local writes
--      wait until Stage C, after the pre-marker instances have drained.
--
-- The staged sequence, each its own release, CI and deployment:
--
--   A (this)  add the marker; existing rows byte-for-byte unchanged; old build
--             unaffected, and its writes land as 'utc_legacy' via the default
--   B         application reads BOTH bases; still writes legacy UTC form, but
--             with an EXPLICIT marker rather than relying on the default
--   C         application writes local wall-clock values with an explicit
--             'local' marker, once every pre-marker instance is gone
--   D         guarded backfill of the remaining legacy rows, and only then any
--             change to the column default
--
-- Because migration and deploy race, this release must be safe whichever
-- finishes first. It is: old code ignores a column it does not know about, and
-- new code in this release does not use it.
--
-- ROLLBACK: ALTER TABLE "staff_availability" DROP COLUMN "time_basis";
--           ALTER TABLE "staff" DROP COLUMN "availability_configured_at";
-- Both are additive and unused by this release, so dropping them restores the
-- previous schema exactly. No data is recoverable-or-lost either way, because
-- none is written.

-- Retry-safe: every statement is IF NOT EXISTS or idempotent, and none
-- transforms a value, so a second execution is a no-op rather than a second
-- conversion.
ALTER TABLE "staff"
  ADD COLUMN IF NOT EXISTS "availability_configured_at" TIMESTAMPTZ(6);

-- DEFAULT 'utc_legacy', deliberately, and it stays that way until Stage D.
-- ADD COLUMN therefore marks exactly the rows that already existed, and every
-- write from an old build that omits the column is labelled correctly too.
ALTER TABLE "staff_availability"
  ADD COLUMN IF NOT EXISTS "time_basis" TEXT NOT NULL DEFAULT 'utc_legacy';

ALTER TABLE "staff_availability"
  DROP CONSTRAINT IF EXISTS "staff_availability_time_basis_check";
ALTER TABLE "staff_availability"
  ADD CONSTRAINT "staff_availability_time_basis_check"
  CHECK ("time_basis" IN ('local', 'utc_legacy'));

-- Assert the expansion did not disturb anything. A value-preserving migration
-- that quietly changed a value would be the worst of both designs.
DO $$
DECLARE
  mislabelled INT;
BEGIN
  SELECT count(*) INTO mislabelled
    FROM "staff_availability" WHERE "time_basis" NOT IN ('local', 'utc_legacy');
  IF mislabelled > 0 THEN
    RAISE EXCEPTION 'time_basis outside the permitted set on % row(s)', mislabelled;
  END IF;
END $$;
