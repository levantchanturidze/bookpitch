import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { getPublicLocation, submitPublicBooking } = await import('@/lib/public-booking');
const { InvalidInputError } = await import('@/lib/auth');

describe('public booking widget', () => {
  let orgId: string;
  let locationId: string;
  let staffId: string;
  let serviceId: string;
  const slug = `pb-${Date.now()}`;

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `pb-${Date.now()}` } });
      const location = await tx.location.create({
        data: {
          organizationId: org.id,
          type: 'clinic',
          name: 'Public Clinic',
          publicSlug: slug,
        },
      });
      const staff = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Pub Doc',
          roleTitle: 'GP',
          specialty: null,
          email: 'pubdoc@example.dev',
        },
      });
      const service = await tx.service.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Check-in',
          category: 'general',
          price: 40,
          durationMinutes: 30,
        },
      });
      return { org, location, staff, service };
    });
    orgId = seed.org.id;
    locationId = seed.location.id;
    staffId = seed.staff.id;
    serviceId = seed.service.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.appointment.deleteMany({ where: { organizationId: orgId } });
      await tx.customer.deleteMany({ where: { organizationId: orgId } });
      await tx.service.deleteMany({ where: { organizationId: orgId } });
      await tx.staff.deleteMany({ where: { organizationId: orgId } });
      await tx.rateLimit.deleteMany({ where: { organizationId: orgId } });
      await tx.location.delete({ where: { id: locationId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  it('getPublicLocation returns null for an unknown slug', async () => {
    expect(await getPublicLocation('does-not-exist')).toBeNull();
  });

  it('getPublicLocation returns the location + staff + services for a valid slug', async () => {
    const loc = await getPublicLocation(slug);
    expect(loc).toBeTruthy();
    expect(loc?.locationId).toBe(locationId);
    expect(loc?.staff.length).toBe(1);
    expect(loc?.services.length).toBe(1);
  });

  it('rejects submissions without consent', async () => {
    await expect(
      submitPublicBooking({
        slug,
        staffId,
        serviceId,
        startsAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
        customerName: 'C',
        customerEmail: 'c@example.dev',
        consented: false,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rejects when neither email nor phone is provided', async () => {
    await expect(
      submitPublicBooking({
        slug,
        staffId,
        serviceId,
        startsAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
        customerName: 'C',
        consented: true,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('creates a pending appointment + customer with consent stamped', async () => {
    const startsAt = new Date(Date.now() + 24 * 3600_000);
    const email = `pubcust-${Date.now()}@example.dev`;
    const result = await submitPublicBooking({
      slug,
      staffId,
      serviceId,
      startsAtIso: startsAt.toISOString(),
      customerName: 'Public Cust',
      customerEmail: email,
      consented: true,
    });
    expect(result.appointmentId).toBeTruthy();

    const [appt, customer] = await withoutRls(async (tx) => [
      await tx.appointment.findUnique({ where: { id: result.appointmentId } }),
      await tx.customer.findFirst({ where: { organizationId: orgId, email } }),
    ]);
    expect(appt?.status).toBe('pending');
    expect(appt?.paymentStatus).toBe('unpaid');
    expect(customer?.consentAt).toBeTruthy();
    expect(customer?.consentVersion).toBe('1.0');
  });

  it('reuses an existing customer when the email matches inside the org', async () => {
    const startsAt = new Date(Date.now() + 25 * 3600_000);
    const email = `pubcust-repeat-${Date.now()}@example.dev`;
    // First booking creates the customer.
    await submitPublicBooking({
      slug,
      staffId,
      serviceId,
      startsAtIso: startsAt.toISOString(),
      customerName: 'Repeat Cust',
      customerEmail: email,
      consented: true,
    });
    // Second booking at a different time.
    await submitPublicBooking({
      slug,
      staffId,
      serviceId,
      startsAtIso: new Date(startsAt.getTime() + 2 * 3600_000).toISOString(),
      customerName: 'Repeat Cust 2', // ignored — existing row stays
      customerEmail: email,
      consented: true,
    });
    const customers = await withoutRls((tx) =>
      tx.customer.findMany({ where: { organizationId: orgId, email } }),
    );
    expect(customers.length).toBe(1);
  });
});
