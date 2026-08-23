import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { authMockRef } = vi.hoisted(() => ({ authMockRef: { fn: vi.fn() } }));
vi.mock('@/auth', () => ({
  auth: authMockRef.fn,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const routeList = await import('@/app/api/customers/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');

// -----------------------------------------------------------------------------
// Keyset pagination, stressed at the boundary that actually breaks it.
//
// The ordering is (createdAt DESC, id DESC). The id is the tie-breaker, and it
// only earns its place when createdAt is NOT unique — which is exactly what a
// bulk import or a fast-fingered receptionist produces. These fixtures
// deliberately collide timestamps.
//
// The randomness is seeded, so a failure is reproducible: same seed, same rows,
// same page boundaries. Nothing here depends on wall-clock time.
// -----------------------------------------------------------------------------

const PREFIX = 'E2E-PHASE16-BOUNDARY';
const SEED = 0x5eed_1216;
const TOTAL = 23; // prime-ish, so no page size divides it evenly

/** Deterministic PRNG (mulberry32) — reproducible across machines and runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let orgId: string;
let ownerId: string;
const created: string[] = [];

function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

type ListBody = { customers: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };

beforeAll(async () => {
  await seedRbacFixtures();
  __clearAuthContextCache();
  const owner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'split-owner@bp.test' },
    select: { id: true },
  });
  ownerId = owner.id;
  const m = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: ownerId, organization: { name: 'Split Practice' } },
    select: { organizationId: true },
  });
  orgId = m.organizationId;

  const rand = rng(SEED);
  const base = Date.now() - 6 * 60 * 60_000;
  // Only 6 distinct timestamps across 23 rows: heavy collisions on the sort key.
  for (let i = 0; i < TOTAL; i++) {
    const bucket = Math.floor(rand() * 6);
    const row = await unsafePrismaAdmin.customer.create({
      data: {
        organizationId: orgId,
        name: `${PREFIX}-${String(i).padStart(2, '0')}`,
        joinedDate: new Date(base),
        createdAt: new Date(base + bucket * 1000),
      },
      select: { id: true },
    });
    created.push(row.id);
  }
});

afterAll(async () => {
  if (created.length) {
    await unsafePrismaAdmin.customer.deleteMany({ where: { id: { in: created } } });
  }
  __clearAuthContextCache();
});

async function pageThrough(limit: number): Promise<string[]> {
  authMockRef.fn.mockResolvedValue(await mockJwt(ownerId, orgId));
  __clearAuthContextCache();
  const seen: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const url = new URL('http://localhost/api/customers');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('q', PREFIX);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await routeList.GET(req(url.toString()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    seen.push(...body.customers.map((c) => c.id));
    cursor = body.nextCursor;
    if (++guard > 100) throw new Error('cursor did not terminate');
  } while (cursor);
  return seen;
}

describe('F16-008 · keyset pagination at the tie-breaker boundary', () => {
  it('the fixture really does collide timestamps', async () => {
    const rows = await unsafePrismaAdmin.customer.findMany({
      where: { organizationId: orgId, name: { startsWith: PREFIX } },
      select: { createdAt: true },
    });
    expect(rows).toHaveLength(TOTAL);
    const distinct = new Set(rows.map((r) => r.createdAt.getTime()));
    // Fewer distinct timestamps than rows — otherwise this proves nothing.
    expect(distinct.size).toBeLessThan(TOTAL);
  });

  it.each([1, 2, 3, 5, 7, 11, TOTAL - 1, TOTAL, TOTAL + 1])(
    'page size %i: every row exactly once',
    async (limit) => {
      const seen = await pageThrough(limit);
      expect(new Set(seen).size, 'duplicates across pages').toBe(seen.length);
      expect(seen.slice().sort()).toEqual(created.slice().sort());
    },
  );

  it('page size does not change the order', async () => {
    const byOne = await pageThrough(1);
    const bySeven = await pageThrough(7);
    expect(bySeven).toEqual(byOne);
  });

  it('a row inserted after page one is not retro-inserted into it', async () => {
    authMockRef.fn.mockResolvedValue(await mockJwt(ownerId, orgId));
    __clearAuthContextCache();
    const first = await routeList.GET(req(`http://localhost/api/customers?limit=5&q=${PREFIX}`));
    const b1 = (await first.json()) as ListBody;
    const pageOne = b1.customers.map((c) => c.id);

    // Newest possible row: it sorts to the very front, ahead of the cursor.
    const inserted = await unsafePrismaAdmin.customer.create({
      data: {
        organizationId: orgId,
        name: `${PREFIX}-late`,
        joinedDate: new Date(),
        createdAt: new Date(),
      },
      select: { id: true },
    });
    created.push(inserted.id);
    try {
      const rest: string[] = [];
      let cursor = b1.nextCursor;
      while (cursor) {
        const res = await routeList.GET(
          req(
            `http://localhost/api/customers?limit=5&q=${PREFIX}&cursor=${encodeURIComponent(cursor)}`,
          ),
        );
        const b = (await res.json()) as ListBody;
        rest.push(...b.customers.map((c) => c.id));
        cursor = b.nextCursor;
      }
      // The new row sorts before the cursor, so later pages never show it —
      // and, critically, nothing already seen is repeated.
      expect(rest).not.toContain(inserted.id);
      for (const id of rest) expect(pageOne).not.toContain(id);
    } finally {
      await unsafePrismaAdmin.customer.deleteMany({ where: { id: inserted.id } });
    }
  });
});
