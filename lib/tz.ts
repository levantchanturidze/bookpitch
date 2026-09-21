/**
 * Timezone conversion boundary.
 *
 * Storage is always UTC. This module is the single place that converts:
 *   UTC ↔ organisation local timezone
 *
 * All functions accept IANA timezone strings. The implementation uses the
 * Intl.DateTimeFormat API (Node 18+ / all modern browsers — no polyfill needed).
 *
 * Limitation: DST transitions at midnight (spring-forward / fall-back) may
 * produce a one-hour error for availability windows that straddle the gap.
 * Georgia has no DST, so this is a deferred concern for future markets.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _fmtCache = new Map<string, Intl.DateTimeFormat>();
function _fmt(tz: string): Intl.DateTimeFormat {
  const key = tz;
  if (!_fmtCache.has(key)) {
    _fmtCache.set(
      key,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    );
  }
  return _fmtCache.get(key)!;
}

function _parts(utc: Date, tz: string) {
  const parts = _fmt(tz).formatToParts(utc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * UTC offset in milliseconds at the given UTC instant, for the given IANA zone.
 * Positive = east of UTC (UTC+). Negative = west of UTC (UTC−).
 */
function utcOffsetMs(utc: Date, tz: string): number {
  const p = _parts(utc, tz);
  const localMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return localMs - utc.getTime();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a UTC Date as a YYYY-MM-DD string in the given timezone.
 * Use this for all date-only display values.
 */
export function toLocalDate(utc: Date, tz: string): string {
  const p = _parts(utc, tz);
  const y = String(p.year).padStart(4, '0');
  const m = String(p.month).padStart(2, '0');
  const d = String(p.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format a UTC Date as HH:MM in the given timezone.
 * Use this for all time-only display values.
 */
export function toLocalTimeHHMM(utc: Date, tz: string): string {
  const p = _parts(utc, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Convert a local YYYY-MM-DD + HH:MM to a UTC Date.
 * Uses today's UTC offset (not 1970's) to avoid historical DST data issues.
 */
export function localToUtc(localDate: string, localHHMM: string, tz: string): Date {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = localHHMM.split(':').map(Number);

  // Use noon UTC on the target date as the reference to read today's offset
  // (noon avoids DST transitions that happen near midnight).
  const refUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offset = utcOffsetMs(refUtc, tz);

  // UTC = local − offset
  const localAsUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  return new Date(localAsUtcMs - offset);
}

/**
 * Return the UTC start and end of a local calendar day.
 * Example (Tbilisi UTC+4): "2026-08-12" → {start: Aug-11 20:00Z, end: Aug-12 20:00Z}
 */
export function localDayRange(localDate: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = localDate.split('-').map(Number);
  // next calendar day in local timezone
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {
    start: localToUtc(localDate, '00:00', tz),
    end: localToUtc(tomorrow, '00:00', tz),
  };
}

/**
 * Return the weekday (0=Sun … 6=Sat) of a local YYYY-MM-DD in the given timezone.
 * Uses local noon to avoid DST transition edge cases at midnight.
 */
export function localDateWeekday(localDate: string, tz: string): number {
  // Convert local noon → UTC, then read the UTC day (which equals the local day
  // for any timezone with a UTC offset between −12 and +14).
  return localToUtc(localDate, '12:00', tz).getUTCDay();
}

/**
 * Convert a Prisma Time column value (stored as UTC epoch date + UTC time-of-day)
 * to a HH:MM string in the given timezone.
 *
 * The DB stores time-of-day values as "1970-01-01T<HH:MM>:00Z". When Prisma
 * reads them, the Date object's UTC hours/minutes match what was stored.
 * We use today's offset (not 1970's) to avoid historical DST oddities.
 */
export function utcTimeValueToLocalHHMM(utcTime: Date, tz: string): string {
  const utcHH = utcTime.getUTCHours();
  const utcMM = utcTime.getUTCMinutes();

  // Build a reference timestamp for TODAY at those UTC hours/minutes,
  // so we read the current (not historical) UTC offset.
  const today = new Date();
  const ref = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), utcHH, utcMM, 0),
  );
  const offsetMs = utcOffsetMs(ref, tz);
  const offsetMin = Math.round(offsetMs / 60_000);

  const localMin = (((utcHH * 60 + utcMM + offsetMin) % 1440) + 1440) % 1440;
  const h = Math.floor(localMin / 60);
  const min = localMin % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Convert a local HH:MM string to the UTC HH:MM that should be stored in a
 * Prisma Time column (which is interpreted as UTC hours/minutes).
 *
 * Uses today's offset (not 1970's) to avoid historical DST oddities.
 */
export function localHHMMToUtcHHMM(localHHMM: string, tz: string): string {
  const [hh, mm] = localHHMM.split(':').map(Number);
  const today = new Date();
  const ref = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hh, mm, 0),
  );
  const offsetMs = utcOffsetMs(ref, tz);
  const offsetMin = Math.round(offsetMs / 60_000);

  const utcMin = (((hh * 60 + mm - offsetMin) % 1440) + 1440) % 1440;
  const uh = Math.floor(utcMin / 60);
  const um = utcMin % 60;
  return `${String(uh).padStart(2, '0')}:${String(um).padStart(2, '0')}`;
}

/**
 * Format a UTC Date for user display (date + time) in the given timezone.
 * Example: "12 Aug 2026, 09:00" for a Tbilisi clinic.
 */
export function formatLocalDateTime(utc: Date, tz: string, locale = 'ka-GE'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(utc);
  } catch {
    // Fallback: ISO without the Z to avoid confusing non-technical users
    return `${toLocalDate(utc, tz)} ${toLocalTimeHHMM(utc, tz)}`;
  }
}

/** Matches a scheduler month parameter: four-digit year, two-digit month. */
export const MONTH_PARAM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 5.4 — the local calendar month, as a HALF-OPEN UTC range plus the anchor the
 * UI should display.
 *
 * The scheduler used to derive one value and use it for both jobs:
 *
 *     monthStart = Date.UTC(y, m, 1) - 86400_000   // widened by a day
 *     ...
 *     monthAnchorIso={monthStart.toISOString()}    // and displayed
 *
 * The widening is legitimate — a local day near UTC midnight must not fall out
 * of the query — but it is a QUERY boundary, and on 2026-09-15 reusing it as
 * the DISPLAY anchor rendered "August 2026" above a September calendar. Two
 * different questions had been given one answer.
 *
 * So this returns them separately, and the anchor is a local date STRING rather
 * than an instant: `YYYY-MM-01` cannot drift across a timezone the way a Date
 * can, which removes the whole class of bug rather than shifting it by an hour.
 *
 * `start`/`end` are the true local month boundaries converted to UTC, so no
 * widening fudge is needed at all — a Tbilisi September begins at 2026-08-31
 * 20:00Z and that is exactly what the range says.
 */
export function localMonthRange(
  yearMonth: string,
  tz: string,
): { anchorLocalDate: string; start: Date; end: Date } {
  if (!MONTH_PARAM_RE.test(yearMonth)) {
    throw new Error(`localMonthRange: "${yearMonth}" is not YYYY-MM`);
  }
  const [y, m] = yearMonth.split('-').map(Number);
  const firstOfThis = `${yearMonth}-01`;
  // Month m is 1-based here, so Date.UTC(y, m, 1) is already the FIRST of the
  // next month — no +1 and no manual 12→1 rollover, which is where this kind of
  // helper usually breaks in December.
  const firstOfNext = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return {
    anchorLocalDate: firstOfThis,
    start: localToUtc(firstOfThis, '00:00', tz),
    end: localToUtc(firstOfNext, '00:00', tz),
  };
}

/**
 * The local `YYYY-MM` a timezone is currently in.
 *
 * Deliberately NOT `new Date().toISOString().slice(0,7)`: for Tbilisi at
 * 2026-09-30 23:00 local that is still "2026-09" in UTC, but for a negative
 * offset near month end the UTC month is already the next one, and the
 * scheduler would open on a month the user is not in.
 */
export function currentLocalYearMonth(tz: string, now: Date = new Date()): string {
  return toLocalDate(now, tz).slice(0, 7);
}
