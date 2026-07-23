import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { addToWaitlist, listWaitlist, removeFromWaitlist, notifyWaitlistForCancelled } =
  await import('@/lib/waitlist');
const { InvalidInputError } = await import('@/lib/auth');

describe('waitlist — add/list/remove + cancellation notifier', () => {
  let orgId: string;
  let locationId: string;
  let staffId: string;
  let serviceId: string;
  let customerA: string;
  let customerB: string;
  let ownerId: string;

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `wl-${Date.now()}` } });
      const owner = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `wl-${Date.now()}@ex.dev`,
          email: `wl-${Date.now()}@ex.dev`,
          fullName: 'WL Owner',
          passwordHash: 'x',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: owner.id, role: 'owner' },
      });
      const location = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'WL Clinic' },
      });
      const staff = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'WL Doc',
          roleTitle: 'GP',
          specialty: null,
        },
      });
      const service = await tx.service.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'WL Service',
          category: 'general',
          price: 50,
          durationMinutes: 30,
        },
      });
      const cA = await tx.customer.create({
        data: { organizationId: org.id, name: 'Waiter A' },
      });
      const cB = await tx.customer.create({
        data: { organizationId: org.id, name: 'Waiter B' },
      });
      return { org, owner, location, staff, service, cA, cB };
    });
    orgId = seed.org.id;
    ownerId = seed.owner.id;
    locationId = seed.location.id;
    staffId = seed.staff.id;
    serviceId = seed.service.id;
    customerA = seed.cA.id;
    customerB = seed.cB.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.waitlist.deleteMany({ where: { organizationId: orgId } });
      await tx.notification.deleteMany({ where: { organizationId: orgId } });
      await tx.customer.deleteMany({ where: { organizationId: orgId } });
      await tx.service.deleteMany({ where: { organizationId: orgId } });
      await tx.staff.deleteMany({ where: { organizationId: orgId } });
      await tx.location.delete({ where: { id: locationId } });
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.appUser.delete({ where: { id: ownerId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  function session() {
    return {
      userId: ownerId,
      organizationId: orgId,
      role: 'owner' as const,
      email: 'wl@example.dev',
    };
  }

  it('rejects a window where from >= to', async () => {
    const now = new Date();
    await expect(
      addToWaitlist(session(), {
        customerId: customerA,
        preferredFrom: now,
        preferredTo: now,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('add + list + remove round-trip', async () => {
    const from = new Date('2027-06-01T00:00:00Z');
    const to = new Date('2027-06-30T00:00:00Z');
    const { id } = await addToWaitlist(session(), {
      customerId: customerA,
      staffId,
      serviceId,
      preferredFrom: from,
      preferredTo: to,
    });
    const listed = await listWaitlist(session());
    expect(listed.find((r) => r.id === id)).toBeTruthy();
    await removeFromWaitlist(session(), id);
    const after = await listWaitlist(session());
    expect(after.find((r) => r.id === id)).toBeUndefined();
  });

  it('notifyWaitlistForCancelled matches by staff/service/window and flips status', async () => {
    const from = new Date('2027-07-01T00:00:00Z');
    const to = new Date('2027-07-31T00:00:00Z');
    const startsAt = new Date('2027-07-15T10:00:00Z');
    const endsAt = new Date('2027-07-15T10:30:00Z');

    // customer A wants THIS staff+service in July.
    const a = await addToWaitlist(session(), {
      customerId: customerA,
      staffId,
      serviceId,
      preferredFrom: from,
      preferredTo: to,
    });
    // customer B wants ANY staff/service in July — should also match.
    const b = await addToWaitlist(session(), {
      customerId: customerB,
      preferredFrom: from,
      preferredTo: to,
    });
    // Out-of-window entry that must NOT match.
    const outside = await addToWaitlist(session(), {
      customerId: customerA,
      preferredFrom: new Date('2027-08-01T00:00:00Z'),
      preferredTo: new Date('2027-08-31T00:00:00Z'),
    });

    const { matched } = await notifyWaitlistForCancelled(orgId, {
      id: 'fake-appt',
      staffId,
      serviceId,
      locationId,
      startsAt,
      endsAt,
    });
    expect(matched).toBe(2);

    const rows = await withoutRls((tx) =>
      tx.waitlist.findMany({ where: { id: { in: [a.id, b.id, outside.id] } } }),
    );
    expect(rows.find((r) => r.id === a.id)?.status).toBe('notified');
    expect(rows.find((r) => r.id === b.id)?.status).toBe('notified');
    expect(rows.find((r) => r.id === outside.id)?.status).toBe('pending');

    // Exactly one rolled-up notification was written.
    const notif = await withoutRls((tx) =>
      tx.notification.findMany({ where: { organizationId: orgId, type: 'waitlist' } }),
    );
    expect(notif.length).toBe(1);
  });
});
