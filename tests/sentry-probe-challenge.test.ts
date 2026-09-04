import { describe, it, expect, beforeEach } from 'vitest';
import {
  issueChallenge,
  redeemChallenge,
  generateProbeNonce,
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/sentry-probe-challenge';
import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// §4.6 — "single-use" has to be a property, not a description.
//
// The first design put an HMAC and its expiry in the probe page's query string.
// It kept CRON_SECRET out of the URL, which was the point, but two things were
// still wrong:
//
//   * a bearer credential in a GET URL reaches browser history, the Referer
//     header, access logs, and whatever CI echoes;
//   * it was REPLAYABLE for its whole five-minute life. Anyone who saw it could
//     use it again, and again. Short-lived is not one-time.
//
// A challenge is now a row, redeemed by
//
//     UPDATE ... SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL
//
// so exactly one caller wins, decided by PostgreSQL. `SELECT` then `UPDATE`
// would let two concurrent requests both see `consumed_at IS NULL` and both
// proceed — which is precisely the case the concurrency test below covers.
// -----------------------------------------------------------------------------

describe('a probe challenge can be redeemed exactly once', () => {
  beforeEach(async () => {
    await unsafePrismaAdmin.$executeRawUnsafe(`DELETE FROM sentry_probe_challenge`);
  });

  it('a fresh challenge redeems and returns its nonce', async () => {
    const c = await issueChallenge();
    expect(await redeemChallenge(c.id)).toBe(c.nonce);
  });

  it('THE DEFECT: a second redemption fails', async () => {
    const c = await issueChallenge();
    expect(await redeemChallenge(c.id)).toBe(c.nonce);
    expect(await redeemChallenge(c.id), 'a replay must not authorise anything').toBeNull();
  });

  it('THE DEFECT: concurrent redemptions produce exactly one winner', async () => {
    // The case a SELECT-then-UPDATE would fail: both requests observe
    // `consumed_at IS NULL`, both proceed, and the challenge authorises twice.
    const c = await issueChallenge();
    const results = await Promise.all(Array.from({ length: 8 }, () => redeemChallenge(c.id)));
    const winners = results.filter((r) => r !== null);
    expect(winners, 'exactly one of eight concurrent redemptions may win').toHaveLength(1);
    expect(winners[0]).toBe(c.nonce);
  });

  it('an expired challenge does not redeem, however unused', async () => {
    const c = await issueChallenge();
    await unsafePrismaAdmin.$executeRawUnsafe(
      `UPDATE sentry_probe_challenge SET expires_at = NOW() - interval '1 second' WHERE id = $1::uuid`,
      c.id,
    );
    expect(await redeemChallenge(c.id)).toBeNull();
  });

  it('expiry is measured on the DATABASE clock', async () => {
    // `expires_at` is written by PostgreSQL. Comparing it against a Node
    // instant would be the same two-clock bug as the retention cutoff, the
    // heartbeat and the reminder lease. Proven by moving the row's expiry with
    // SQL and observing the decision change — no Node time is involved at all.
    const c = await issueChallenge();
    await unsafePrismaAdmin.$executeRawUnsafe(
      `UPDATE sentry_probe_challenge SET expires_at = NOW() + interval '1 hour' WHERE id = $1::uuid`,
      c.id,
    );
    expect(await redeemChallenge(c.id)).toBe(c.nonce);
  });

  it('an unknown, malformed or absent id is refused without distinction', async () => {
    for (const bad of [
      undefined,
      null,
      '',
      'not-a-uuid',
      '../../etc/passwd',
      "' OR 1=1 --",
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(await redeemChallenge(bad as string), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the TTL is short, and the challenge expires on its own', async () => {
    const c = await issueChallenge();
    const ttlSeconds = (c.expiresAt.getTime() - Date.now()) / 1000;
    // Generous bounds: this asserts the order of magnitude, not the clock.
    expect(ttlSeconds).toBeGreaterThan(CHALLENGE_TTL_SECONDS - 120);
    expect(ttlSeconds).toBeLessThan(CHALLENGE_TTL_SECONDS + 120);
  });

  it('issuing sweeps long-dead rows so the table cannot grow forever', async () => {
    const old = await issueChallenge();
    await unsafePrismaAdmin.$executeRawUnsafe(
      `UPDATE sentry_probe_challenge SET expires_at = NOW() - interval '2 hours' WHERE id = $1::uuid`,
      old.id,
    );
    await issueChallenge();
    const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM sentry_probe_challenge WHERE id = $1::uuid`,
      old.id,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('nonces are unguessable and match the shape the probes accept', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = generateProbeNonce();
      expect(n).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });
});

describe('nothing secret can leak through the URL', () => {
  it('the cookie is __Host- prefixed, which forces Secure and a root path', () => {
    // A browser refuses to set a `__Host-` cookie that is not Secure, is not
    // path=/, or carries a Domain attribute. The name itself is the guarantee.
    expect(CHALLENGE_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('the probe page takes no credential in its query string', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync('app/probe/sentry/page.tsx', 'utf8');
    // searchParams must not be read at all: anything read from there is in the
    // URL, and anything in the URL is in history, referrers and logs.
    expect(page, 'the probe page must not read searchParams').not.toMatch(/searchParams/);
    expect(page).not.toMatch(/\btoken\b/);
  });

  it('no route hands a secret back in a URL or a body it should not', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of [
      'app/api/health/sentry-probe/token/route.ts',
      'app/api/health/sentry-probe/route.ts',
      'app/probe/sentry/page.tsx',
      'app/probe/sentry/BrowserProbe.tsx',
    ]) {
      // String literals are stripped first. `NextResponse.json({ error:
      // 'CRON_SECRET not configured' })` NAMES the variable in a message, which
      // is fine and useful; the first version of this test could not tell that
      // apart from emitting its value.
      const src = readFileSync(f, 'utf8').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
      // What must never happen: the secret, or the value read from it,
      // interpolated into anything that leaves the server.
      for (const emit of [
        /NextResponse\.json\([^;]*\$\{\s*secret/,
        /cookies\.set\([^;]*\$\{?\s*secret/,
        /redirect\([^;]*secret/,
        /searchParams\.set\([^;]*secret/,
        /console\.[a-z]+\([^;]*secret/,
        /log\.[a-z]+\([^;]*\bsecret\b/,
      ]) {
        expect(src, `${f} must not emit the secret (${emit})`).not.toMatch(emit);
      }
    }
  });
});
