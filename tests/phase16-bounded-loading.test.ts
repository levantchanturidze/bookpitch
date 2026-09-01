import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/auth', () => ({
  auth: authMockRef.fn,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { authMockRef } = vi.hoisted(() => ({ authMockRef: { fn: vi.fn() } }));

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const routeList = await import('@/app/api/customers/route');
const routeAppts = await import('@/app/api/appointments/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { parsePageSize, decodeCustomerCursor, encodeCustomerCursor, CUSTOMER_PAGE_MAX } =
  await import('@/lib/customers');
const { parseAppointmentRange, APPOINTMENT_RANGE_MAX_DAYS } = await import('@/lib/appointments');

// -----------------------------------------------------------------------------
// F16-008. The patients screen loaded every customer in the organization plus
// every treatment-history row for each, then decrypted per row, to render a
// list of names. The scheduler accepted any date range at all.
//
// These tests hold the boundary in both directions: bounded and correct, not
// bounded by silently dropping records.
// -----------------------------------------------------------------------------

const PREFIX = 'E2E-PHASE16-PAGE';
const TOTAL = 7; // > one page at pageSize 3, so paging is exercised for real
let orgId: string;
let otherOrgId: string;
let ownerId: string;
const created: string[] = [];

function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  await seedRbacFixtures();
  __clearAuthContextCache();

  const owner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'split-owner@bp.test' },
    select: { id: true },
  });
  ownerId = owner.id;
  const membership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: ownerId, organization: { name: 'Split Practice' } },
    select: { organizationId: true },
  });
  orgId = membership.organizationId;

  const other = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { id: { not: orgId } },
    select: { id: true },
  });
  otherOrgId = other.id;

  // Deterministic, distinct createdAt so ordering is unambiguous.
  const base = Date.now() - 60 * 60_000;
  for (let i = 0; i < TOTAL; i++) {
    const row = await unsafePrismaAdmin.customer.create({
      data: {
        organizationId: orgId,
        name: `${PREFIX}-${String(i).padStart(2, '0')}-Zoya`,
        phone: `+99500000${String(i).padStart(2, '0')}`,
        email: `${PREFIX.toLowerCase()}-${i}@bp.test`,
        joinedDate: new Date(base),
        createdAt: new Date(base + i * 1000),
      },
      select: { id: true },
    });
    created.push(row.id);
  }
  // One row in the other tenant that must never appear.
  const foreign = await unsafePrismaAdmin.customer.create({
    data: {
      organizationId: otherOrgId,
      name: `${PREFIX}-FOREIGN-Zoya`,
      joinedDate: new Date(base),
    },
    select: { id: true },
  });
  created.push(foreign.id);
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

type ListBody = {
  customers: Array<Record<string, unknown> & { id: string; name: string }>;
  nextCursor: string | null;
  hasMore: boolean;
};

describe('F16-008 · customer list is bounded', () => {
  it('page size is validated, not silently clamped', () => {
    expect(parsePageSize(null)).toBeGreaterThan(0);
    expect(() => parsePageSize('0')).toThrow(/positive integer/i);
    expect(() => parsePageSize('-3')).toThrow(/positive integer/i);
    expect(() => parsePageSize('abc')).toThrow(/positive integer/i);
    expect(() => parsePageSize(String(CUSTOMER_PAGE_MAX + 1))).toThrow(/must not exceed/i);
    expect(parsePageSize(String(CUSTOMER_PAGE_MAX))).toBe(CUSTOMER_PAGE_MAX);
  });

  it('rejects a malformed cursor rather than ignoring it', () => {
    expect(() => decodeCustomerCursor('nonsense')).toThrow(/malformed/i);
    expect(() => decodeCustomerCursor('not-a-date|11111111-1111-4111-8111-111111111111')).toThrow(
      /malformed/i,
    );
    expect(() => decodeCustomerCursor(`${new Date().toISOString()}|not-a-uuid`)).toThrow(
      /malformed/i,
    );
    const round = encodeCustomerCursor({
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(decodeCustomerCursor(round).id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('the list projection carries no clinical, insurance or history fields', async () => {
    await asOwner();
    const res = await routeList.GET(req('http://localhost/api/customers?limit=3'));
    const body = await jsonOf<ListBody>(res);
    expect(res.status).toBe(200);
    expect(body.customers.length).toBe(3);
    for (const c of body.customers) {
      for (const hidden of [
        'allergies',
        'clinicalNotes',
        'treatmentHistory',
        'insurerName',
        'insurancePolicyNumber',
        'dob',
      ]) {
        expect(c).not.toHaveProperty(hidden);
      }
      // The allergy warning survives as a boolean — a safety affordance, not data.
      expect(typeof c.hasAllergies).toBe('boolean');
    }
  });

  it('paginates the whole set with no duplicates and no omissions', async () => {
    await asOwner();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = new URL('http://localhost/api/customers');
      url.searchParams.set('limit', '3');
      url.searchParams.set('q', PREFIX);
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await routeList.GET(req(url.toString()));
      const body: ListBody = await jsonOf<ListBody>(res);
      expect(res.status).toBe(200);
      seen.push(...body.customers.map((c) => c.id));
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(20); // cursor must terminate
    } while (cursor);

    const mine = created.slice(0, TOTAL);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen.slice().sort()).toEqual(mine.slice().sort()); // no omissions
    expect(pages).toBeGreaterThan(1); // paging genuinely happened
  });

  it('search runs across the organization, not over the loaded page', async () => {
    await asOwner();
    // Ask for one row per page, then search for a name that lives on the LAST
    // page. A client-side filter over page one could not find it.
    const target = `${PREFIX}-06-Zoya`;
    const res = await routeList.GET(
      req(`http://localhost/api/customers?limit=1&q=${encodeURIComponent(target)}`),
    );
    const body = await jsonOf<ListBody>(res);
    expect(res.status).toBe(200);
    expect(body.customers.map((c) => c.name)).toContain(target);
  });

  it('search matches phone and email as well as name', async () => {
    await asOwner();
    // Derived from the same expression the fixture uses, so the test cannot
    // drift from the data it is asserting against.
    const phone = `+99500000${String(3).padStart(2, '0')}`;
    for (const q of [phone, `${PREFIX.toLowerCase()}-4@bp.test`]) {
      const res = await routeList.GET(
        req(`http://localhost/api/customers?q=${encodeURIComponent(q)}`),
      );
      const body = await jsonOf<ListBody>(res);
      expect(body.customers.length, `no match for ${q}`).toBeGreaterThan(0);
    }
  });

  it('never returns another tenant’s rows, even when the search matches them', async () => {
    await asOwner();
    const res = await routeList.GET(
      req(`http://localhost/api/customers?limit=${CUSTOMER_PAGE_MAX}&q=Zoya`),
    );
    const body = await jsonOf<ListBody>(res);
    expect(body.customers.length).toBeGreaterThan(0);
    expect(body.customers.map((c) => c.name)).not.toContain(`${PREFIX}-FOREIGN-Zoya`);
    const foreignRow = await withoutRls((tx) =>
      tx.customer.findFirst({
        where: { organizationId: otherOrgId, name: `${PREFIX}-FOREIGN-Zoya` },
      }),
    );
    expect(foreignRow, 'the foreign row must exist, or this proves nothing').not.toBeNull();
  });
});

describe('F16-008 · scheduler ranges are bounded', () => {
  it('requires both bounds', () => {
    expect(() => parseAppointmentRange(null, '2026-02-01T00:00:00Z')).toThrow(/required/i);
    expect(() => parseAppointmentRange('2026-01-01T00:00:00Z', null)).toThrow(/required/i);
  });

  it('rejects unparseable bounds', () => {
    expect(() => parseAppointmentRange('yesterday', '2026-02-01T00:00:00Z')).toThrow(/ISO/i);
  });

  it('rejects an inverted or empty range', () => {
    expect(() => parseAppointmentRange('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z')).toThrow(
      /after/i,
    );
    expect(() => parseAppointmentRange('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toThrow(
      /after/i,
    );
  });

  it('rejects an excessive range instead of clamping it', () => {
    expect(() => parseAppointmentRange('1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).toThrow(
      /must not exceed/i,
    );
  });

  // Complement: a real calendar month must still be accepted, or the guard has
  // broken the feature rather than bounded it.
  it('accepts a month view and the maximum span exactly', () => {
    const month = parseAppointmentRange('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
    expect(month.to.getTime()).toBeGreaterThan(month.from.getTime());

    const from = new Date('2026-03-01T00:00:00Z');
    const to = new Date(from.getTime() + APPOINTMENT_RANGE_MAX_DAYS * 86_400_000);
    expect(() => parseAppointmentRange(from.toISOString(), to.toISOString())).not.toThrow();
    const over = new Date(to.getTime() + 1000);
    expect(() => parseAppointmentRange(from.toISOString(), over.toISOString())).toThrow(
      /must not exceed/i,
    );
  });

  it('the endpoint enforces the range, not just the helper', async () => {
    await asOwner();
    const res = await routeAppts.GET(
      req('http://localhost/api/appointments?from=1970-01-01T00:00:00Z&to=2100-01-01T00:00:00Z'),
    );
    expect(res.status).toBe(400);
  });

  it('half-open [from, to): a boundary appointment belongs to exactly one range', () => {
    // The seam between two adjacent month views. With a closed upper bound the
    // same appointment would be returned by both.
    const boundary = new Date('2026-04-01T00:00:00Z');
    const first = parseAppointmentRange('2026-03-01T00:00:00Z', boundary.toISOString());
    const second = parseAppointmentRange(boundary.toISOString(), '2026-04-30T00:00:00Z');
    const inFirst =
      boundary.getTime() >= first.from.getTime() && boundary.getTime() < first.to.getTime();
    const inSecond =
      boundary.getTime() >= second.from.getTime() && boundary.getTime() < second.to.getTime();
    expect(inFirst).toBe(false);
    expect(inSecond).toBe(true);
  });
});
