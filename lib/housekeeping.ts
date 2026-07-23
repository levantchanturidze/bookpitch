import { withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Housekeeping: prunes rows that are safe to drop once they're stale.
//   - rate_limit rows older than 1 day (windows are per-minute; a day of
//     history is plenty to answer "was this org throttled recently?").
//   - verification_tokens whose `expires` has passed.
//   - notifications marked read and older than 30 days.
// Each pass emits a structured log line with the delete counts.
// -----------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 3600 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

export type HousekeepingResult = {
  rateLimit: number;
  verificationTokens: number;
  notifications: number;
};

export async function runHousekeeping(now: Date = new Date()): Promise<HousekeepingResult> {
  const rlCutoff = new Date(now.getTime() - ONE_DAY_MS);
  const notifCutoff = new Date(now.getTime() - THIRTY_DAYS_MS);

  const result = await withoutRls(async (tx) => {
    const rateLimit = await tx.rateLimit.deleteMany({
      where: { windowStart: { lt: rlCutoff } },
    });
    const verificationTokens = await tx.verificationToken.deleteMany({
      where: { expires: { lt: now } },
    });
    const notifications = await tx.notification.deleteMany({
      where: { read: true, createdAt: { lt: notifCutoff } },
    });
    return {
      rateLimit: rateLimit.count,
      verificationTokens: verificationTokens.count,
      notifications: notifications.count,
    };
  });
  log.info('housekeeping.ok', result);
  return result;
}
