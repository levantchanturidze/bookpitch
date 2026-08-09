import { withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Housekeeping: prunes rows that are safe to drop once they're stale.
//
// App-level tables:
//   - rate_limit rows older than 1 day
//   - verification_tokens whose `expires` has passed
//   - notifications marked read and older than 30 days
//
// Platform security tables (added here rather than a separate cron so a
// single scheduled invocation keeps all stale-row accumulation under control):
//   - platform_rate_limit rows older than 1 day
//   - pending_registrations whose expires_at has passed (unverified signups)
//   - platform_reauth_grant rows that are either consumed or expired
//     (retained 1 day for audit history, then swept)
//   - app_user_recovery_codes that have been used (retained 30 days)
// -----------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 3600 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

export type HousekeepingResult = {
  rateLimit: number;
  verificationTokens: number;
  notifications: number;
  platformRateLimit: number;
  pendingRegistrations: number;
  reauthGrants: number;
  usedRecoveryCodes: number;
};

export async function runHousekeeping(now: Date = new Date()): Promise<HousekeepingResult> {
  const rlCutoff = new Date(now.getTime() - ONE_DAY_MS);
  const notifCutoff = new Date(now.getTime() - THIRTY_DAYS_MS);
  const reauthCutoff = new Date(now.getTime() - ONE_DAY_MS);
  const recoveryCodeCutoff = new Date(now.getTime() - THIRTY_DAYS_MS);

  const result = await withoutRls(async (tx) => {
    // ── App-level tables ──────────────────────────────────────────────────────
    const rateLimit = await tx.rateLimit.deleteMany({
      where: { windowStart: { lt: rlCutoff } },
    });
    const verificationTokens = await tx.verificationToken.deleteMany({
      where: { expires: { lt: now } },
    });
    const notifications = await tx.notification.deleteMany({
      where: { read: true, createdAt: { lt: notifCutoff } },
    });

    // ── Platform security tables ──────────────────────────────────────────────
    const platformRateLimit = await tx.platformRateLimit.deleteMany({
      where: { windowStart: { lt: rlCutoff } },
    });
    // Pending registrations that were never verified (expired tokens).
    const pendingRegistrations = await tx.pendingRegistration.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    // Reauth grants that are consumed OR expired by more than 1 day.
    // We retain them briefly so the audit trail remains queryable for
    // short-lived incident triage; 24h is enough for any on-call rotation.
    const reauthGrants = await tx.platformReauthGrant.deleteMany({
      where: {
        OR: [
          { consumedAt: { lt: reauthCutoff } },
          { expiresAt: { lt: reauthCutoff }, consumedAt: null },
        ],
      },
    });
    // Used recovery codes — retained 30 days for audit, then swept.
    const usedRecoveryCodes = await tx.appUserRecoveryCode.deleteMany({
      where: { usedAt: { lt: recoveryCodeCutoff } },
    });

    return {
      rateLimit: rateLimit.count,
      verificationTokens: verificationTokens.count,
      notifications: notifications.count,
      platformRateLimit: platformRateLimit.count,
      pendingRegistrations: pendingRegistrations.count,
      reauthGrants: reauthGrants.count,
      usedRecoveryCodes: usedRecoveryCodes.count,
    };
  });
  log.info('housekeeping.ok', result);
  return result;
}
