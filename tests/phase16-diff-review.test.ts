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

const { unsafePrismaAdmin, sessionOptions } = await import('@/lib/db');
const routeList = await import('@/app/api/customers/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { encodeCustomerCursor, buildCustomerListWhere } = await import('@/lib/customers');
const { parseAppointmentRange } = await import('@/lib/appointments');

// -----------------------------------------------------------------------------
// Integrated review of the Phase 16 diff — the properties that only hold when
// the pieces are considered together, rather than commit by commit.
// -----------------------------------------------------------------------------

const PREFIX = 'E2E-PHASE16-REVIEW';
let orgId: string;
let otherOrgId: string;
let ownerId: string;
const created: string[] = [];
let foreignCursor: string;

function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

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
  const other = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { id: { not: orgId }, ownerUserId: { not: null } },
    select: { id: true },
  });
  otherOrgId = other.id;

  const base = Date.now() - 3 * 60 * 60_000;
  for (let i = 0; i < 4; i++) {
    const row = await unsafePrismaAdmin.customer.create({
      data: {
        organizationId: orgId,
        name: `${PREFIX}-mine-${i}`,
        joinedDate: new Date(base),
        createdAt: new Date(base + i * 1000),
      },
      select: { id: true },
    });
    created.push(row.id);
  }
  // A row in the other tenant, and a cursor minted from it.
  const foreign = await unsafePrismaAdmin.customer.create({
    data: {
      organizationId: otherOrgId,
      name: `${PREFIX}-foreign`,
      joinedDate: new Date(base),
      createdAt: new Date(base + 10_000),
    },
    select: { id: true, createdAt: true },
  });
  created.push(foreign.id);
  foreignCursor = encodeCustomerCursor(foreign);
});

afterAll(async () => {
  if (created.length) {
    await unsafePrismaAdmin.customer.deleteMany({ where: { id: { in: created } } });
  }
  __clearAuthContextCache();
});

async function asOwner() {
  authMockRef.fn.mockResolvedValue(await mockJwt(ownerId, orgId));
  __clearAuthContextCache();
}

type ListBody = { customers: Array<{ id: string; name: string }>; nextCursor: string | null };

describe('review · pagination cannot be steered across tenants', () => {
  it('the organization predicate is ANDed, never replaced by the cursor', () => {
    const where = buildCustomerListWhere({
      organizationId: orgId,
      search: 'anything',
      cursor: { createdAt: new Date(), id: '11111111-1111-4111-8111-111111111111' },
    });
    // Whatever else is in the clause, the tenant term is always the first
    // conjunct — a cursor cannot displace it.
    expect(where.AND[0]).toEqual({ organizationId: orgId });
  });

  it('a cursor minted from another tenant returns nothing of theirs', async () => {
    await asOwner();
    const res = await routeList.GET(
      req(`http://localhost/api/customers?limit=50&cursor=${encodeURIComponent(foreignCursor)}`),
    );
    const body = (await res.json()) as ListBody;
    expect(res.status).toBe(200);
    expect(body.customers.map((c) => c.name)).not.toContain(`${PREFIX}-foreign`);
    for (const c of body.customers) expect(c.name).not.toMatch(/foreign/);
  });

  it('search and pagination compose — the filter survives the cursor', async () => {
    await asOwner();
    const first = await routeList.GET(
      req(`http://localhost/api/customers?limit=2&q=${PREFIX}-mine`),
    );
    const b1 = (await first.json()) as ListBody;
    expect(b1.customers).toHaveLength(2);
    expect(b1.nextCursor).toBeTruthy();

    const second = await routeList.GET(
      req(
        `http://localhost/api/customers?limit=2&q=${PREFIX}-mine&cursor=${encodeURIComponent(b1.nextCursor!)}`,
      ),
    );
    const b2 = (await second.json()) as ListBody;
    // Page two still respects the search: no unrelated rows leak in.
    for (const c of b2.customers) expect(c.name).toContain(`${PREFIX}-mine`);
    // And no row appears on both pages.
    const overlap = b1.customers.filter((c) => b2.customers.some((d) => d.id === c.id));
    expect(overlap).toHaveLength(0);
  });

  it('a row deleted between pages does not shift the window', async () => {
    await asOwner();
    const first = await routeList.GET(
      req(`http://localhost/api/customers?limit=2&q=${PREFIX}-mine`),
    );
    const b1 = (await first.json()) as ListBody;
    const seenFirst = b1.customers.map((c) => c.id);

    // Keyset paging is anchored to a value, not an offset, so removing an
    // already-seen row cannot pull an unseen row backwards into page one.
    const victim = seenFirst[0];
    const row = await unsafePrismaAdmin.customer.findUniqueOrThrow({ where: { id: victim } });
    await unsafePrismaAdmin.customer.delete({ where: { id: victim } });
    try {
      const second = await routeList.GET(
        req(
          `http://localhost/api/customers?limit=2&q=${PREFIX}-mine&cursor=${encodeURIComponent(b1.nextCursor!)}`,
        ),
      );
      const b2 = (await second.json()) as ListBody;
      for (const c of b2.customers) expect(seenFirst).not.toContain(c.id);
    } finally {
      await unsafePrismaAdmin.customer.create({ data: { ...row } });
    }
  });
});

describe('review · scheduler range semantics', () => {
  it('bounds are absolute instants, so a zone suffix does not move them', () => {
    // Same instant, three spellings. Half-open windows must agree.
    const a = parseAppointmentRange('2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z');
    const b = parseAppointmentRange('2026-03-01T04:00:00+04:00', '2026-03-08T04:00:00+04:00');
    expect(a.from.getTime()).toBe(b.from.getTime());
    expect(a.to.getTime()).toBe(b.to.getTime());
  });

  it('a DST transition neither omits nor duplicates the boundary hour', () => {
    // Europe/London springs forward 2026-03-29 01:00 UTC. Two adjacent
    // half-open windows across it must partition the timeline exactly.
    const before = parseAppointmentRange('2026-03-28T00:00:00Z', '2026-03-29T00:00:00Z');
    const after = parseAppointmentRange('2026-03-29T00:00:00Z', '2026-03-30T00:00:00Z');
    expect(before.to.getTime()).toBe(after.from.getTime()); // no gap
    const instant = new Date('2026-03-29T00:00:00Z').getTime();
    const inBefore = instant >= before.from.getTime() && instant < before.to.getTime();
    const inAfter = instant >= after.from.getTime() && instant < after.to.getTime();
    expect([inBefore, inAfter]).toEqual([false, true]); // exactly one
  });

  it('the range is rejected before any query is built', () => {
    // parseAppointmentRange is pure and throws; nothing reaches the database.
    expect(() => parseAppointmentRange('1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).toThrow(
      /must not exceed/i,
    );
  });
});

describe('review · pool session options', () => {
  it('adds the timezone without discarding operator options', () => {
    expect(sessionOptions('postgresql://u:p@h:5432/db')).toBe('-c timezone=UTC');
    expect(sessionOptions('postgresql://u:p@h:5432/db?schema=public')).toBe('-c timezone=UTC');
    expect(sessionOptions('postgresql://u:p@h:5432/db?options=-c%20statement_timeout%3D5000')).toBe(
      '-c statement_timeout=5000 -c timezone=UTC',
    );
  });

  it('survives a connection string that is not URL-shaped', () => {
    expect(sessionOptions('host=localhost dbname=x')).toBe('-c timezone=UTC');
  });
});

describe('review · no security predicate compares a Prisma timestamp to Node time', () => {
  it('the audited paths are clean', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'lib/rbac/context.ts',
      'lib/platform/break-glass.ts',
      'lib/platform/impersonation.ts',
      'lib/housekeeping.ts',
      'lib/admin/ownership-transfer.ts',
      'lib/invitations.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      const code = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect(code, `${file} compares expiry to new Date()`).not.toMatch(
        /expiresAt:\s*\{\s*(gt|gte|lt|lte):\s*new Date\(\)/,
      );
      expect(code, `${file} compares expiry to Date.now()`).not.toMatch(
        /expiresAt[^\n]*[<>]=?\s*Date\.now\(\)/,
      );
    }
  });

  it('no raw SQL binds a JS Date into a timestamptz security predicate', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'lib/platform/break-glass.ts',
      'lib/platform/impersonation.ts',
      'lib/housekeeping.ts',
      'lib/invitations.ts',
      'lib/admin/ownership-transfer.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} binds a value into an expiry comparison`).not.toMatch(
        /expires_at\s*(<=|<|>=|>)\s*\$\{/,
      );
    }
  });
});
