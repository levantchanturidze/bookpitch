import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { bearerMatches } = await import('@/lib/bearer-secret');
const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { removeSubscription } = await import('@/lib/push');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const unsubscribeRoute = await import('@/app/api/push/unsubscribe/route');
const ROUTES = {
  '/api/cron/audit-digest': (await import('@/app/api/cron/audit-digest/route')).POST,
  '/api/cron/db-partitions': (await import('@/app/api/cron/db-partitions/route')).POST,
  '/api/cron/housekeeping': (await import('@/app/api/cron/housekeeping/route')).POST,
  '/api/cron/reminders': (await import('@/app/api/cron/reminders/route')).POST,
  '/api/cron/retention': (await import('@/app/api/cron/retention/route')).POST,
  '/api/health/ops': (await import('@/app/api/health/ops/route')).GET,
  '/api/health/sentry-probe': (await import('@/app/api/health/sentry-probe/route')).POST,
  '/api/health/sentry-probe/token': (await import('@/app/api/health/sentry-probe/token/route'))
    .POST,
} as Record<string, (req: NextRequest) => Promise<Response>>;

const ROOT = path.resolve(__dirname, '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const APP_SOURCE = ['app', 'lib', 'components'].flatMap((d) => sourceFiles(path.join(ROOT, d)));

// -----------------------------------------------------------------------------
// 1. Bearer secrets are compared in constant time (CWE-208).
//
// Seven routes compared `Authorization` with `!==`, which returns at the first
// differing byte: a timing side channel on CRON_SECRET. /api/health/ops alone
// compared in constant time. All eight now share lib/bearer-secret.
// -----------------------------------------------------------------------------
describe('bearerMatches accepts exactly `Bearer <secret>` and nothing else', () => {
  const secret = 's3cret-value-for-tests';

  it('accepts the exact header', () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
  });

  it.each([
    ['a wrong secret of the same length', `Bearer ${secret.slice(0, -1)}X`],
    ['a longer value', `Bearer ${secret}x`],
    ['a shorter value', `Bearer ${secret.slice(0, -1)}`],
    ['the bare secret', secret],
    ['a lowercase scheme', `bearer ${secret}`],
    ['an empty header', ''],
  ])('refuses %s', (_label, header) => {
    expect(bearerMatches(header, secret)).toBe(false);
  });

  it('refuses a missing header', () => {
    expect(bearerMatches(null, secret)).toBe(false);
    expect(bearerMatches(undefined, secret)).toBe(false);
  });

  it('an empty secret authorises nothing, not even `Bearer `', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer', '')).toBe(false);
  });
});

describe('every bearer-protected route refuses a wrong secret before doing any work', () => {
  const SECRET = 'route-test-secret-value';
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });

  it.each(Object.keys(ROUTES))('%s', async (route) => {
    for (const header of [`Bearer ${SECRET.slice(0, -1)}X`, `Bearer ${SECRET}x`, 'Bearer', null]) {
      const req = {
        headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? header : null) },
      } as unknown as NextRequest;
      const res = await ROUTES[route](req);
      expect(res.status, `${route} with ${String(header)}`).toBe(401);
    }
  });

  it('no route compares a bearer header with === or !== any more', () => {
    const DIRECT = /[!=]==\s*`Bearer \$\{|`Bearer \$\{[^}]+\}`\s*[!=]==/;
    const offenders = APP_SOURCE.filter((f) => DIRECT.test(readFileSync(f, 'utf8'))).map((f) =>
      path.relative(ROOT, f),
    );
    expect(offenders, 'use bearerMatches from lib/bearer-secret').toEqual([]);
    // COMPLEMENT: the pattern sees both spellings of the old comparison.
    expect(DIRECT.test("if (req.headers.get('authorization') !== `Bearer ${secret}`) {")).toBe(
      true,
    );
    expect(DIRECT.test('if (`Bearer ${secret}` === provided) {')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2. A push subscription is removed by its owner only.
//
// POST /api/push/unsubscribe checked that a session existed, then deleted by
// endpoint alone with RLS bypassed: any signed-in user who knew another user's
// endpoint URL could remove that user's subscription.
// -----------------------------------------------------------------------------
describe('removing a push subscription is scoped to its owner', () => {
  const stamp = Date.now();
  let orgId = '';
  const users: Record<'a' | 'b', string> = { a: '', b: '' };
  const endpoint = (who: 'a' | 'b', n = 1) => `https://push.example/${who}-${n}-${stamp}`;

  async function subscribe(who: 'a' | 'b', ep: string) {
    await withoutRls((tx) =>
      tx.pushSubscription.create({
        data: { userId: users[who], endpoint: ep, p256dh: 'k', auth: 'a' },
      }),
    );
  }
  const exists = async (ep: string) =>
    (await unsafePrismaAdmin.pushSubscription.count({ where: { endpoint: ep } })) === 1;
  async function unsubscribeAs(who: 'a' | 'b', ep: string) {
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(users[who], orgId));
    return unsubscribeRoute.POST(
      new Request('http://x/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: ep }),
      }) as unknown as NextRequest,
    );
  }

  beforeAll(async () => {
    const fx = await withoutRls(async (tx) => {
      const role = await tx.role.findFirstOrThrow({
        where: { key: 'PROVIDER', organizationId: null },
        select: { id: true },
      });
      // Archived: an ownerless live organisation breaks the ownership invariant.
      const org = await tx.organization.create({
        data: { name: `push-owner-${stamp}`, status: 'archived' },
        select: { id: true },
      });
      const ids: string[] = [];
      for (const who of ['a', 'b']) {
        const u = await tx.appUser.create({
          data: {
            authProvider: 'credentials',
            authSubject: `push-owner-${who}-${stamp}@bp.test`,
            email: `push-owner-${who}-${stamp}@bp.test`,
          },
          select: { id: true },
        });
        await tx.membership.create({
          data: { organizationId: org.id, userId: u.id, role: 'practitioner', roleId: role.id },
        });
        ids.push(u.id);
      }
      return { org: org.id, a: ids[0], b: ids[1] };
    });
    orgId = fx.org;
    users.a = fx.a;
    users.b = fx.b;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.pushSubscription.deleteMany({ where: { userId: { in: [users.a, users.b] } } });
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.appUser.deleteMany({ where: { id: { in: [users.a, users.b] } } });
      await tx.organization.deleteMany({ where: { id: orgId } });
    });
  });

  it("removeSubscription cannot remove another user's subscription", async () => {
    await subscribe('b', endpoint('b', 1));
    await removeSubscription(users.a, endpoint('b', 1));
    expect(await exists(endpoint('b', 1))).toBe(true);
  });

  it('COMPLEMENT: it removes the caller’s own, and is idempotent', async () => {
    await subscribe('a', endpoint('a', 1));
    await removeSubscription(users.a, endpoint('a', 1));
    expect(await exists(endpoint('a', 1))).toBe(false);
    await expect(removeSubscription(users.a, endpoint('a', 1))).resolves.toBeUndefined();
  });

  it("the route, signed in as A, leaves B's subscription in place", async () => {
    await subscribe('b', endpoint('b', 2));
    const res = await unsubscribeAs('a', endpoint('b', 2));
    expect(res.status).toBe(200);
    expect(await exists(endpoint('b', 2))).toBe(true);
  });

  it('COMPLEMENT: the route removes the signed-in user’s own subscription', async () => {
    await subscribe('a', endpoint('a', 2));
    const res = await unsubscribeAs('a', endpoint('a', 2));
    expect(res.status).toBe(200);
    expect(await exists(endpoint('a', 2))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3. No production code catches a database error inside a transaction.
//
// The same rule #123 enforces for tests: a failed statement has already aborted
// the transaction, so a .catch on a transaction-client call lets the callback
// return while the commit rolls back what came before it. lib/push.ts was the
// one production instance (a single-statement transaction, harmless in itself);
// with it gone, the rule can hold for all of app/, lib/ and components/.
// -----------------------------------------------------------------------------
describe('no production code catches a DB error inside a transaction', () => {
  const ON_TX =
    /\btx\s*\.\s*\$?\w+\s*(?:\.\s*\w+\s*)?\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\.catch\(/;

  it('no .catch on a transaction-client call in app/, lib/ or components/', () => {
    const offenders = APP_SOURCE.filter((f) => ON_TX.test(readFileSync(f, 'utf8'))).map((f) =>
      path.relative(ROOT, f),
    );
    expect(offenders).toEqual([]);
  });

  it('COMPLEMENT: the pattern finds the shape lib/push.ts used to have', () => {
    const c = '.cat' + 'ch(';
    expect(
      ON_TX.test(
        `withoutRls((tx) => tx.pushSubscription.delete({ where: { endpoint } })${c}() => null));`,
      ),
    ).toBe(true);
    expect(
      ON_TX.test(
        `await withoutRls((tx) => tx.pushSubscription.deleteMany({ where: { endpoint } }))${c}() => {});`,
      ),
    ).toBe(false);
  });
});
