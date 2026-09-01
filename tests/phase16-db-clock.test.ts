import { describe, it, expect, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { dbNow, dbNowMs, unsafePrismaAdmin } = await import('@/lib/db');

// -----------------------------------------------------------------------------
// F16-010. `SELECT now()` read through Prisma's raw path is parsed as UTC
// whatever the session TimeZone actually is, so off-UTC servers hand back an
// instant wrong by exactly the zone offset — silently, with no error.
//
// Production Supabase runs `UTC` and was never wrong. Local Postgres runs
// `Asia/Tbilisi` and returned a value four hours ahead. Everything that derived
// a deadline from it inherited the error: a 60-minute break-glass ceiling
// became five hours, and housekeeping deleted tokens that were still live.
//
// The three timezones below are the proof that the fix is not merely "correct
// on this laptop".
// -----------------------------------------------------------------------------

const ZONES = ['UTC', 'Asia/Tbilisi', 'America/Sao_Paulo'] as const; // +00, +04, -03

/** Runs `fn` with the session TimeZone forced, restoring it afterwards. */
async function inZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const [{ tz: original }] = await unsafePrismaAdmin.$queryRaw<[{ tz: string }]>`
    SELECT current_setting('TimeZone') AS tz
  `;
  await unsafePrismaAdmin.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
  try {
    return await fn();
  } finally {
    await unsafePrismaAdmin.$executeRawUnsafe(`SET TIME ZONE '${original}'`);
  }
}

describe('F16-010 · dbNowMs() is the instant, not its rendering', () => {
  it('agrees with the process clock', async () => {
    const before = Date.now();
    const db = await dbNowMs();
    const after = Date.now();
    expect(db).toBeGreaterThan(before - 2000);
    expect(db).toBeLessThan(after + 2000);
  });

  it('returns the same absolute instant in every session timezone', async () => {
    const readings: Array<{ zone: string; ms: number; nodeMs: number }> = [];
    for (const zone of ZONES) {
      await inZone(zone, async () => {
        readings.push({ zone, ms: await dbNowMs(), nodeMs: Date.now() });
      });
    }
    for (const r of readings) {
      // Each reading must match the process clock at the moment it was taken.
      // A zone-rendering bug shows up here as a multi-hour delta.
      expect(Math.abs(r.ms - r.nodeMs), `${r.zone} drifted from the process clock`).toBeLessThan(
        5000,
      );
    }
    // And the readings must be monotonic across zones — they were taken in order.
    const spread = Math.max(...readings.map((r) => r.ms)) - Math.min(...readings.map((r) => r.ms));
    expect(spread, 'zone changed the instant').toBeLessThan(5000);
  });

  // The complement, and the defect itself: the raw read this replaced moves by
  // exactly the zone offset. On UTC the two agree, which is why production was
  // never wrong; off-UTC they diverge by hours.
  it('the raw SELECT now() it replaced moves with the zone; dbNowMs does not', async () => {
    for (const zone of ZONES) {
      await inZone(zone, async () => {
        const [{ now: rendered }] = await unsafePrismaAdmin.$queryRaw<[{ now: unknown }]>`
          SELECT now() AS now
        `;
        const [{ off }] = await unsafePrismaAdmin.$queryRaw<[{ off: unknown }]>`
          SELECT extract(epoch from (now() - (now() AT TIME ZONE 'UTC'))) AS off
        `;
        const naive = new Date(rendered as string).getTime();
        const safe = await dbNowMs();
        const offsetMs = Number(off) * 1000;

        // naive == safe + zoneOffset, in every zone including UTC where it is 0.
        expect(Math.abs(naive - safe - offsetMs), `${zone}`).toBeLessThan(5000);
        if (zone !== 'UTC') {
          expect(
            Math.abs(naive - safe),
            `${zone} should differ from the safe read`,
          ).toBeGreaterThan(60 * 60_000);
        }
      });
    }
  });

  it('dbNow() is the Date form of the same instant', async () => {
    const d = await dbNow();
    expect(d).toBeInstanceOf(Date);
    expect(Math.abs(d.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('every security-sensitive path reads the clock through the helper', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'lib/housekeeping.ts',
      'lib/platform/break-glass.ts',
      'lib/platform/impersonation.ts',
      'lib/rbac/context.ts',
      'lib/admin/ownership-transfer.ts',
      'lib/invitations.ts',
      'tests/helpers/db-time.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} still reads a rendered now()`).not.toMatch(
        /\$queryRaw<[^>]*>`\s*SELECT\s+now\(\)\s+AS\s+now/i,
      );
      // Either read the instant through the helper, or — better — never take
      // it out of the database at all and compare with transaction_timestamp().
      expect(src, `${file} decides expiry on the process clock`).toMatch(
        /dbNow(Ms)?\(|transaction_timestamp\(\)/,
      );
    }
  });

  it('no raw SQL binds a JS Date for a security comparison', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['lib/platform/break-glass.ts', 'lib/platform/impersonation.ts']) {
      const src = readFileSync(file, 'utf8');
      // The sweep and the end-write compare in SQL on both sides.
      expect(src).not.toMatch(/expires_at\s*<=\s*\$\{/);
      expect(src).not.toMatch(/ended_at\s*=\s*\$\{db/);
    }
    const bg = readFileSync('lib/platform/break-glass.ts', 'utf8');
    expect(bg.match(/transaction_timestamp\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
