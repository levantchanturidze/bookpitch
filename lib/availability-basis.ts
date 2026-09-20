import { toLocalTimeHHMM } from '@/lib/tz';

// -----------------------------------------------------------------------------
// How to read a staff_availability row, whichever basis it was written in.
//
// WHY THIS EXISTS INSTEAD OF A ONE-STEP DATA REWRITE.
//
// .github/workflows/migrate.yml applies migrations on push to main, and Vercel
// deploys from the same push IN PARALLEL. Its own header says so: "the deployed
// code may briefly run against the pre-migration schema". The corollary is the
// dangerous half — the PREVIOUS release keeps serving for a minute or two
// against the POST-migration database.
//
// A migration that rewrote 05:00 into 09:00 would therefore be read by the old
// build, which still interprets the column as UTC, as a window four hours out.
// Worse, if anybody saved the availability editor during that window the old
// build would write a UTC value into a column whose default now says 'local' —
// mislabelled at birth, and then protected from correction by the very
// provenance marker meant to prevent double conversion. Silent and permanent.
//
// So the migration changes no values at all. It adds `time_basis`, marks the
// rows that already existed as 'utc_legacy', and defaults everything written
// afterwards to 'local'. Old rows keep the exact bytes the old build expects,
// which makes the overlap window a non-event, and this module teaches the new
// build to read both. A later backfill can normalise the legacy rows whenever
// it likes, because by then nothing depends on which basis they are in.
// -----------------------------------------------------------------------------

/** The two ways a row's time-of-day columns can be meant. */
export type TimeBasis = 'local' | 'utc_legacy';

export type AvailabilityRow = {
  startTime: Date;
  endTime: Date;
  timeBasis?: string | null;
};

/** Minutes past midnight of a Prisma Time column's stored wall-clock digits. */
function storedMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

/**
 * Minutes past LOCAL midnight for one boundary of an availability row.
 *
 * `local` rows are already local, so the digits are used as they are.
 * `utc_legacy` rows hold a UTC time-of-day and are converted with the
 * location's real offset.
 *
 * An unrecognised basis is treated as legacy, which is the conservative
 * reading: it is what every row written before this column existed meant, and
 * misreading a local row as legacy shifts a window rather than silently
 * accepting a booking outside it.
 */
export function availabilityMinutes(value: Date, basis: string | null | undefined, tz: string) {
  if (basis === 'local') return storedMinutes(value);

  // Rebase onto a recent date before converting. The column's own epoch is
  // 1970, and Tbilisi was UTC+3 then and is UTC+4 now — anchoring on the stored
  // date would be an hour out on every legacy row.
  const today = new Date();
  const rebased = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
      value.getUTCHours(),
      value.getUTCMinutes(),
    ),
  );
  const [h, m] = toLocalTimeHHMM(rebased, tz).split(':').map(Number);
  return h * 60 + m;
}

/** Both boundaries of a row, as local minutes past midnight. */
export function availabilityRangeMinutes(
  row: AvailabilityRow,
  tz: string,
): { startMin: number; endMin: number } {
  return {
    startMin: availabilityMinutes(row.startTime, row.timeBasis, tz),
    endMin: availabilityMinutes(row.endTime, row.timeBasis, tz),
  };
}

/** `HH:MM` for display, in the location's local calendar. */
export function availabilityHHMM(
  value: Date,
  basis: string | null | undefined,
  tz: string,
): string {
  const total = availabilityMinutes(value, basis, tz);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
