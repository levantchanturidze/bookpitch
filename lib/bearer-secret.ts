import { createHash, timingSafeEqual } from 'node:crypto';

// -----------------------------------------------------------------------------
// Does an `Authorization` header carry `Bearer <secret>`? In constant time.
//
// Six routes (the five cron jobs and the Sentry probe-token mint) compared the
// header with `!==`. A string comparison returns at the first differing byte,
// so how long a refusal takes says how much of a guess was right: a timing
// side channel on CRON_SECRET (CWE-208). /api/health/ops already compared in
// constant time; every bearer route now shares this one function.
//
// Both sides are hashed first, so the comparison is over two equal-length
// digests: timingSafeEqual needs equal lengths, and comparing lengths
// directly would leak the header's length relationship to the secret.
// -----------------------------------------------------------------------------
export function bearerMatches(header: string | null | undefined, secret: string): boolean {
  // An empty secret must never authorise anything, including `Bearer `.
  if (!header || !secret) return false;
  const given = createHash('sha256').update(header).digest();
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(given, expected);
}
