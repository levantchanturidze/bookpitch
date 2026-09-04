import { randomBytes } from 'node:crypto';
import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// Single-use authorisation for the browser Sentry probe.
//
// The browser half of Sentry verification has to run in a real browser, on the
// deployed app, through the real client bundle — nothing runnable from Node
// exercises `NEXT_PUBLIC_SENTRY_DSN`, the browser transport or the browser
// source maps. So there has to be a PAGE, and that page deliberately throws.
//
// Authorising a page is harder than authorising an API call, because a browser
// navigation is a GET:
//
//   * `CRON_SECRET` in the URL is out — a URL reaches history, referrers,
//     access logs, and whatever the CI runner echoes;
//   * an HMAC in the URL, which is what this replaced, keeps the secret out but
//     is still a bearer credential in a URL, and it is REPLAYABLE for its whole
//     lifetime. "Short-lived" is not "one-time", and describing it as one-time
//     would have been a claim rather than a property.
//
// So: the challenge is a database row, the id travels in an HttpOnly cookie,
// and redemption is
//
//     UPDATE ... SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL
//
// which exactly one caller can win — decided by PostgreSQL, not by an
// application-level check that two concurrent requests could both pass.
//
// Expiry is `expires_at > NOW()`, evaluated by the database, for the same
// reason every other deadline in this schema is: `expires_at` is written by
// PostgreSQL and comparing it against a Node instant compares two machines'
// clocks.
// -----------------------------------------------------------------------------

/** Long enough for a browser to load a page, short enough to be uninteresting. */
export const CHALLENGE_TTL_SECONDS = 300;

/** The cookie the probe page reads. HttpOnly, so page JavaScript cannot see it. */
export const CHALLENGE_COOKIE = '__Host-bookpitch-sentry-probe';

/** 16 random bytes, hex. A public correlation id, not a secret. */
export function generateProbeNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Mint one challenge. Also sweeps dead rows, so the table cannot grow without
 * bound on a deployment where the probe is used and forgotten.
 */
export async function issueChallenge(): Promise<{
  id: string;
  nonce: string;
  expiresAt: Date;
}> {
  await unsafePrismaAdmin.$executeRaw`
    DELETE FROM sentry_probe_challenge
     WHERE expires_at < NOW() - interval '1 hour'`;

  const nonce = generateProbeNonce();
  const rows = await unsafePrismaAdmin.$queryRaw<Array<{ id: string; expires_at: Date }>>`
    INSERT INTO sentry_probe_challenge (nonce, expires_at)
    VALUES (${nonce}, NOW() + make_interval(secs => ${CHALLENGE_TTL_SECONDS}::int))
    RETURNING id, expires_at`;
  return { id: rows[0].id, nonce, expiresAt: rows[0].expires_at };
}

/**
 * Redeem a challenge, exactly once.
 *
 * Returns the nonce on the single successful redemption and `null` for every
 * other outcome — unknown id, malformed id, already consumed, expired. The
 * caller cannot distinguish them, and should not: an unauthorised visitor
 * learns only that there is nothing here.
 *
 * The atomicity is the whole point. `SELECT` then `UPDATE` would let two
 * concurrent requests both observe `consumed_at IS NULL` and both proceed;
 * doing it in one statement means PostgreSQL picks the winner.
 */
export async function redeemChallenge(id: string | undefined | null): Promise<string | null> {
  if (typeof id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  try {
    const rows = await unsafePrismaAdmin.$queryRaw<Array<{ nonce: string }>>`
      UPDATE sentry_probe_challenge
         SET consumed_at = NOW()
       WHERE id = ${id}::uuid
         AND consumed_at IS NULL
         AND expires_at > NOW()
      RETURNING nonce`;
    return rows[0]?.nonce ?? null;
  } catch {
    // A malformed uuid that slipped the regex, or the table not existing on a
    // deployment that predates the migration. Neither is authorisation.
    return null;
  }
}
