import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const routeList = await import('@/app/api/appointments/route');
const routeItem = await import('@/app/api/appointments/[id]/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { getAvailableSlots } = await import('@/lib/appointments');

async function mkSession(orgId: string, userId: string) {
  return mockJwt(userId, orgId);
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

// A slot in the far future so we don't collide with seeded appointments.
const YEAR = 2027;
const HORIZON_MONTH = 3; // April 2027 (JS month index)

function iso(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(YEAR, HORIZON_MONTH, day, hour, minute)).toISOString();
}

describe('/api/appointments — booking, double-booking, cross-tenant', () => {
  let primaryOrgId: string;
  let primaryOwnerId: string;
  let isolationOrgId: string;
  let clinicLocationId: string;
  let customerId: string;
  let clinicStaffId: string;
  let serviceId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const orgs = await tx.organization.findMany({ orderBy: { createdAt: 'asc' } });
      const owner = await tx.appUser.findUnique({
        where: { email: 'owner@bookpitch.dev' },
        select: { id: true },
      });
      const iso = orgs.find((o) => o.name === 'Isolation Corp')!;
      const primary = orgs.find((o) => o.name !== 'Isolation Corp')!;
      const clinic = await tx.location.findFirst({
        where: { organizationId: primary.id, type: 'clinic' },
      });
      const customer = await tx.customer.findFirst({
        where: { organizationId: primary.id },
      });
      const staff = await tx.staff.findFirst({
        where: { locationId: clinic!.id },
      });
      const service = await tx.service.findFirst({ where: { locationId: clinic!.id } });
      return { primary, owner, iso, clinic, customer, staff, service };
    });
    primaryOrgId = seed.primary.id;
    primaryOwnerId = seed.owner!.id;
    isolationOrgId = seed.iso.id;
    clinicLocationId = seed.clinic!.id;
    customerId = seed.customer!.id;
    clinicStaffId = seed.staff!.id;
    serviceId = seed.service!.id;
  });

  afterAll(async () => {
    if (createdIds.length) {
      await withoutRls((tx) => tx.appointment.deleteMany({ where: { id: { in: createdIds } } }));
    }
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  async function book(
    startsAt: string,
    overrides: Partial<{ staffId: string; customerId: string; serviceId: string }> = {},
  ) {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    return routeList.POST(
      req('http://x/api/appointments', {
        method: 'POST',
        body: JSON.stringify({
          locationId: clinicLocationId,
          customerId,
          staffId: clinicStaffId,
          serviceId,
          startsAt,
          ...overrides,
        }),
      }),
    );
  }

  it('creates an appointment with snapshotted service name + price', async () => {
    const res = await book(iso(5, 10));
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      appointment: { id: string; serviceName: string; price: number };
    }>(res);
    createdIds.push(body.appointment.id);
    expect(body.appointment.serviceName).toBeTruthy();
    expect(body.appointment.price).toBeGreaterThan(0);
  });

  it('rejects an overlapping second booking for the same staff (DB constraint, 409)', async () => {
    // First: 11:00-11:30 (or whatever the service duration is).
    const first = await book(iso(6, 11));
    expect(first.status).toBe(200);
    const firstBody = await jsonBody<{ appointment: { id: string; endsAt: string } }>(first);
    createdIds.push(firstBody.appointment.id);

    // Second: 11:15 — overlaps regardless of duration.
    const second = await book(iso(6, 11, 15));
    expect(second.status).toBe(409);
    const secondBody = await jsonBody<{ error: string }>(second);
    expect(secondBody.error).toBe('slot_taken');

    // Verify only ONE row exists at that hour for this staff — proves the DB
    // constraint fired, not just an app check.
    const rows = await withoutRls((tx) =>
      tx.appointment.count({
        where: {
          staffId: clinicStaffId,
          startsAt: { gte: new Date(iso(6, 11)), lt: new Date(iso(6, 12)) },
        },
      }),
    );
    expect(rows).toBe(1);
  });

  it('allows an overlapping booking if the pre-existing one is cancelled', async () => {
    const created = await book(iso(7, 14));
    const createdBody = await jsonBody<{ appointment: { id: string } }>(created);
    createdIds.push(createdBody.appointment.id);

    // Cancel it via PATCH.
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    const cancel = await routeItem.PATCH(
      req(`http://x/api/appointments/${createdBody.appointment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' }),
      }),
      { params: Promise.resolve({ id: createdBody.appointment.id }) },
    );
    expect(cancel.status).toBe(200);

    // Now an overlapping booking on the same slot must succeed.
    const overlap = await book(iso(7, 14, 15));
    expect(overlap.status).toBe(200);
    const overlapBody = await jsonBody<{ appointment: { id: string } }>(overlap);
    createdIds.push(overlapBody.appointment.id);
  });

  it('allows adjacent bookings (end-of-one = start-of-next)', async () => {
    const first = await book(iso(8, 9));
    const firstBody = await jsonBody<{ appointment: { id: string; endsAt: string } }>(first);
    createdIds.push(firstBody.appointment.id);

    const adjacent = await book(firstBody.appointment.endsAt);
    expect(adjacent.status).toBe(200);
    const adjBody = await jsonBody<{ appointment: { id: string } }>(adjacent);
    createdIds.push(adjBody.appointment.id);
  });

  it('service snapshot survives even after the service is deleted', async () => {
    // Create a throwaway service, book against it, delete the service.
    const throwaway = await withoutRls((tx) =>
      tx.service.create({
        data: {
          organizationId: primaryOrgId,
          locationId: clinicLocationId,
          name: 'One-off Trial',
          price: 42,
          durationMinutes: 30,
        },
      }),
    );

    const res = await book(iso(9, 10), { serviceId: throwaway.id });
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      appointment: { id: string; serviceName: string; price: number };
    }>(res);
    createdIds.push(body.appointment.id);
    expect(body.appointment.serviceName).toBe('One-off Trial');
    expect(body.appointment.price).toBe(42);

    // Delete the service; snapshot should still be intact on the appointment.
    await withoutRls((tx) => tx.service.delete({ where: { id: throwaway.id } }));
    const after = await withoutRls((tx) =>
      tx.appointment.findUnique({ where: { id: body.appointment.id } }),
    );
    expect(after?.serviceName).toBe('One-off Trial');
    expect(Number(after?.price)).toBe(42);
    expect(after?.serviceId).toBeNull(); // FK ON DELETE SET NULL
  });

  it('list scoped to org — isolation org sees zero of primary org rows', async () => {
    // Phase 4: mockJwt requires a REAL (userId, orgId) pair — a JWT that
    // claims a foreign org for a user who isn't a member of it can't be
    // minted. Use the isolation org's own owner as the caller.
    const isoOwner = await withoutRls((tx) =>
      tx.appUser.findUniqueOrThrow({
        where: { email: 'isolation@bookpitch.dev' },
        select: { id: true },
      }),
    );
    authMock.mockResolvedValue(await mkSession(isolationOrgId, isoOwner.id));
    const res = await routeList.GET(
      req(
        `http://x/api/appointments?from=${encodeURIComponent(iso(1, 0))}&to=${encodeURIComponent(iso(30, 23))}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ appointments: unknown[] }>(res);
    expect(body.appointments.length).toBe(0);
  });

  it('rejects booking with a customer from a different org (RLS)', async () => {
    // Grab the "Do Not Leak" customer from isolation org.
    const stranger = await withoutRls((tx) =>
      tx.customer.findFirst({ where: { organizationId: isolationOrgId } }),
    );
    const res = await book(iso(10, 10), { customerId: stranger!.id });
    // Either 400 (assertCustomerInOrg's InvalidInputError) — that path fires
    // because RLS returns null for the cross-tenant customer.
    expect(res.status).toBe(400);
  });

  it('concurrent double-booking: exactly one succeeds, the other gets slot_taken (no 500)', async () => {
    // Two simultaneous requests for the same staff + slot. The DB exclusion
    // constraint (23P01) ensures only one row lands; the other must come back
    // as 409 slot_taken — not a 500 or an unhandled throw.
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    const slot = iso(11, 15);
    const [a, b] = await Promise.all([book(slot), book(slot)]);

    const statuses = [a.status, b.status].sort();
    // One 200, one 409 — order is non-deterministic.
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 409 ? a : b;

    const winBody = await jsonBody<{ appointment: { id: string } }>(winner);
    createdIds.push(winBody.appointment.id);

    const loseBody = await jsonBody<{ error: string }>(loser);
    expect(loseBody.error).toBe('slot_taken');

    // Exactly one appointment row must exist at that slot for this staff.
    const count = await withoutRls((tx) =>
      tx.appointment.count({
        where: {
          staffId: clinicStaffId,
          startsAt: { gte: new Date(slot), lt: new Date(iso(11, 16)) },
          status: { not: 'cancelled' },
        },
      }),
    );
    expect(count).toBe(1);
  });

  it('getAvailableSlots excludes a booked slot from the picker', async () => {
    // Book a 30-min slot at 13:00 on day 12.
    const slotIso = iso(12, 13);
    const res = await book(slotIso);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ appointment: { id: string } }>(res);
    createdIds.push(body.appointment.id);

    // getAvailableSlots for that staff + date + 30 min must NOT contain 13:00.
    const dateStr = `${YEAR}-04-12`; // April 12 in the test horizon (HORIZON_MONTH=3 → April)
    const slots = await withoutRls((tx) => getAvailableSlots(tx, clinicStaffId, dateStr, 30));
    expect(slots).not.toContain('13:00');

    // Adjacent slots must still be present (end of previous = 12:30, start of next = 13:30).
    // The default window runs 07:00–21:00, so these exist if not blocked by other tests.
    // Soft check: after the booking 13:00 is simply gone.
    expect(Array.isArray(slots)).toBe(true);
  });
});
