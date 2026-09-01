// -----------------------------------------------------------------------------
// Test helper: obtain timestamps relative to the PostgreSQL server clock.
//
// Security-sensitive code (startBreakGlass, conflict checks, expiry guards)
// uses `SELECT now()` to anchor time to the DB server, not the Node process.
// Tests that create fixture rows compared against PostgreSQL time must do the
// same — using Date.now() when the DB server clock diverges from the Node
// clock will produce rows that appear already-expired to the DB.
//
// Usage:
//   const { nowMs, future, past } = await dbTime();
//   const expiresAt = future(60 * 60_000); // 1 hour from DB now
// -----------------------------------------------------------------------------

import { dbNowMs, unsafePrismaAdmin } from '@/lib/db';

export interface DbTimeHandle {
  /** PostgreSQL server time as a JS timestamp (ms since epoch). */
  nowMs: number;
  /** Returns a Date `offsetMs` milliseconds after the DB server's current time. */
  future(offsetMs: number): Date;
  /** Returns a Date `offsetMs` milliseconds before the DB server's current time. */
  past(offsetMs: number): Date;
}

/**
 * Query the PostgreSQL server for its current time and return helpers for
 * producing timestamps relative to that server time.
 *
 * Use this wherever fixture rows must be compared against PostgreSQL's `now()`
 * inside application transactions — e.g., break-glass sessions, impersonation
 * sessions, and reauth grants.
 */
export async function dbTime(): Promise<DbTimeHandle> {
  // Via dbNowMs(): `SELECT now()` alone is rendered in the session TimeZone and
  // parsed as UTC by Prisma's raw path, so fixtures anchored to it were offset
  // by the zone. Locally that was four hours, and every assertion built on it
  // was wrong in the same direction, which is why nothing noticed (F16-010).
  const nowMs = await dbNowMs(unsafePrismaAdmin);

  return {
    nowMs,
    future: (offsetMs) => new Date(nowMs + offsetMs),
    past: (offsetMs) => new Date(nowMs - offsetMs),
  };
}
