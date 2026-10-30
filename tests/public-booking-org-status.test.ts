import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { getPublicLocation } = await import('@/lib/public-booking');
const route = await import('@/app/api/public/book/route');
const { can, requireAuthContext } = await import('@/lib/rbac');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// The public widget took bookings for an organisation in ANY status. can()
// refuses every org-plane action in a suspended or archived organisation, so a
// booking taken there was one its staff could neither see nor manage, and for
// an archived organisation the customer's details landed in a tenant awaiting
// purge. The widget now refuses exactly the statuses can() refuses. The
// parity case below is what keeps the two from drifting: one rule, two paths.
// -----------------------------------------------------------------------------

// Every value organizations_status_check admits.
const STATUSES = ['pending_setup', 'trial', 'active', 'suspended', 'archived'] as const;

const stamp = Date.now();
const fx = { org: '', owner: '', loc: '', staff: '', service: '', slug: `org-status-${stamp}` };
let slot = 0;

function nextSlot(): string {
  slot += 1;
  const d = new Date(Date.now() + 4 * 24 * 3_600_000);
  d.setUTCHours(6 + slot, 0, 0, 0);
  return d.toISOString();
}

const post = (email: string) =>
  route.POST(
    new Request('http://localhost/api/public/book', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: fx.slug,
        staffId: fx.staff,
        serviceId: fx.service,
        startsAt: nextSlot(),
        customerName: 'Widget Visitor',
        customerEmail: email,
        consented: true,
      }),
    }) as unknown as NextRequest,
  );

async function setStatus(status: (typeof STATUSES)[number]) {
  await unsafePrismaAdmin.organization.update({ where: { id: fx.org }, data: { status } });
}

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `org-status-${stamp}@bp.test`,
        email: `org-status-${stamp}@bp.test`,
      },
      select: { id: true },
    });
    const org = await tx.organization.create({
      data: { name: `org-status-${stamp}`, status: 'active', ownerUserId: owner.id },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: role.id },
    });
    const loc = await tx.location.create({
      data: {
        organizationId: org.id,
        name: 'Status',
        type: 'clinic',
        timezone: 'UTC',
        publicSlug: fx.slug,
      },
      select: { id: true },
    });
    const staff = await tx.staff.create({
      data: { organizationId: org.id, locationId: loc.id, name: 'Status Dr', roleTitle: 'GP' },
      select: { id: true },
    });
    const service = await tx.service.create({
      data: {
        organizationId: org.id,
        locationId: loc.id,
        name: 'Consult',
        price: 10,
        durationMinutes: 30,
      },
      select: { id: true },
    });
    return { org: org.id, owner: owner.id, loc: loc.id, staff: staff.id, service: service.id };
  });
  Object.assign(fx, seeded);
});

afterAll(async () => {
  // Archived first: the deferred org-owner trigger refuses removing a live
  // organisation's owner membership. Children before parents, including the
  // bookings a regression would have let through.
  await withoutRls(async (tx) => {
    await tx.organization.update({ where: { id: fx.org }, data: { status: 'archived' } });
    await tx.notification.deleteMany({ where: { organizationId: fx.org } });
    await tx.appointment.deleteMany({ where: { organizationId: fx.org } });
    await tx.customer.deleteMany({ where: { organizationId: fx.org } });
    await tx.service.deleteMany({ where: { organizationId: fx.org } });
    await tx.staff.deleteMany({ where: { organizationId: fx.org } });
    await tx.location.deleteMany({ where: { organizationId: fx.org } });
    await tx.rateLimit.deleteMany({ where: { organizationId: fx.org } });
    await tx.membership.deleteMany({ where: { organizationId: fx.org } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.org]);
  await withoutRls(async (tx) => {
    await tx.organization.deleteMany({ where: { id: fx.org } });
    await tx.appUser.deleteMany({ where: { id: fx.owner } });
  });
});

describe('the public widget refuses exactly the organisations can() refuses', () => {
  for (const status of STATUSES) {
    it(`${status}: the widget and can() agree`, async () => {
      await setStatus(status);

      __clearAuthContextCache();
      authMock.mockResolvedValue(await mockJwt(fx.owner, fx.org));
      const ctx = await requireAuthContext();
      const operating = can(ctx, 'booking.read', { organizationId: fx.org });

      const location = await getPublicLocation(fx.slug);
      expect(location !== null, 'the widget page renders').toBe(operating);

      const email = `visitor-${status}-${stamp}@bp.test`;
      const res = await post(email);
      const created = await unsafePrismaAdmin.customer.count({
        where: { organizationId: fx.org, email },
      });
      if (operating) {
        expect(res.status).toBe(201);
        expect(created).toBe(1);
      } else {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'booking widget not found' });
        expect(created, 'nothing is written for a refused booking').toBe(0);
      }
    });
  }

  it('the statuses refused are suspended and archived, no more and no fewer', async () => {
    // Pins the rule itself, so a change to can() or to the widget that keeps
    // the two equal but moves both is still seen.
    const refused: string[] = [];
    for (const status of STATUSES) {
      await setStatus(status);
      if ((await getPublicLocation(fx.slug)) === null) refused.push(status);
    }
    expect(refused).toEqual(['suspended', 'archived']);
  });
});
