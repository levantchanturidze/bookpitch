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
const { can } = await import('@/lib/rbac/can');
const { buildAuthContext, __clearAuthContextCache } = await import('@/lib/rbac/context');
const { NAV_ITEMS } = await import('@/components/shell/nav-items');
const { mockJwt } = await import('./helpers/session');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const routeList = await import('@/app/api/customers/route');
const routeOne = await import('@/app/api/customers/[id]/route');

// -----------------------------------------------------------------------------
// F16-012. MARKETING held client.read:contact, so it reached the patients
// surface and, through it, every patient's name, email, phone and date of
// birth. A marketing role reading identifiable patient contact data in a
// clinical product, granted by default and never separately justified.
//
// It now holds report.own and report.branch only — aggregate analytics, which
// is what the role is for. Nothing was granted in exchange.
//
// Navigation visibility is a UX signal, not the control, so this checks the
// route directly as well: a MARKETING user who types the URL must still be
// refused.
// -----------------------------------------------------------------------------

const PREFIX = 'E2E-PHASE16-MKT';
let mktUserId: string;
let mktMembershipId: string;
let orgId: string;
let otherOrgId: string;
let ownerId: string;
let customerId: string;

function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

beforeAll(async () => {
  await seedRbacFixtures();
  __clearAuthContextCache();

  // Self-healing: a run that failed before its teardown leaves an active user
  // with no membership behind, which another suite's invariant check
  // legitimately reports. Deleting is not always possible — an audited action
  // leaves append-only audit_log rows that hold the foreign key — so residue is
  // marked 'deleted', which is what the invariant actually cares about.
  await unsafePrismaAdmin.appUser.updateMany({
    where: { email: { startsWith: `${PREFIX.toLowerCase()}-` } },
    data: { status: 'deleted' },
  });

  const owner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'split-owner@bp.test' },
    select: { id: true },
  });
  ownerId = owner.id;
  const ownerMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: ownerId, organization: { name: 'Split Practice' } },
    select: { organizationId: true },
  });
  orgId = ownerMembership.organizationId;

  const other = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { id: { not: orgId }, ownerUserId: { not: null } },
    select: { id: true },
  });
  otherOrgId = other.id;

  const marketingRole = await unsafePrismaAdmin.role.findFirstOrThrow({
    where: { key: 'MARKETING', organizationId: null },
    select: { id: true },
  });

  // A MARKETING member of an org that already has its owner, so the
  // last-owner invariant is untouched by this fixture.
  const user = await unsafePrismaAdmin.appUser.create({
    data: {
      email: `${PREFIX.toLowerCase()}-${Date.now()}@bp.test`,
      status: 'active',
      authProvider: 'credentials',
      authSubject: `${PREFIX.toLowerCase()}-${Date.now()}`,
    },
    select: { id: true },
  });
  mktUserId = user.id;
  const membership = await unsafePrismaAdmin.membership.create({
    data: {
      userId: mktUserId,
      organizationId: orgId,
      roleId: marketingRole.id,
      role: 'receptionist', // legacy enum column, unrelated to the RBAC role
      status: 'active',
    },
    select: { id: true },
  });
  mktMembershipId = membership.id;

  const customer = await unsafePrismaAdmin.customer.findFirstOrThrow({
    where: { organizationId: orgId },
    select: { id: true },
  });
  customerId = customer.id;
});

afterAll(async () => {
  // One transaction. Vitest forks share this database, so a membership deleted
  // a moment before its user leaves an active user with no membership — which
  // another suite's invariant check will legitimately catch. Removing both
  // together means that state is never observable.
  if (mktUserId || mktMembershipId) {
    await unsafePrismaAdmin.$transaction(async (tx) => {
      if (mktMembershipId) {
        await tx.membership.deleteMany({ where: { id: mktMembershipId } });
      }
      if (mktUserId) {
        // Mark first, then try to remove. If this user performed an audited
        // action the append-only audit_log holds the FK and the delete fails —
        // by then it is already 'deleted', so no invariant is left violated.
        await tx.appUser.updateMany({ where: { id: mktUserId }, data: { status: 'deleted' } });
        await tx.appUser.deleteMany({ where: { id: mktUserId } }).catch(() => undefined);
      }
    });
  }
  __clearAuthContextCache();
});

async function marketingCtx() {
  __clearAuthContextCache();
  const ctx = await buildAuthContext(mktUserId, mktMembershipId);
  if (!ctx) throw new Error('no context for the marketing fixture');
  return ctx;
}

async function asMarketing() {
  authMockRef.fn.mockResolvedValue(await mockJwt(mktUserId, orgId));
  __clearAuthContextCache();
}

async function asOwner() {
  authMockRef.fn.mockResolvedValue(await mockJwt(ownerId, orgId));
  __clearAuthContextCache();
}

describe('F16-012 · MARKETING cannot reach patient data', () => {
  it('holds exactly the two aggregate reporting grants', async () => {
    const role = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'MARKETING', organizationId: null },
      select: { permissions: { select: { permissionKey: true } } },
    });
    const keys = role.permissions.map((p) => p.permissionKey).sort();
    expect(keys).toEqual(['report.branch', 'report.own']);
  });

  it.each([
    'client.read:contact',
    'client.read:full',
    'client.read:basic',
    'client.create',
    'client.update',
    'client.export',
    'clinical_note.read:any',
  ])('is denied %s', async (permission) => {
    const ctx = await marketingCtx();
    expect(can(ctx, permission, { organizationId: orgId })).toBe(false);
  });

  it('keeps the aggregate analytics it legitimately needs', async () => {
    const ctx = await marketingCtx();
    expect(can(ctx, 'report.branch', { organizationId: orgId })).toBe(true);
  });

  it('sees no patients entry in the sidebar', async () => {
    const ctx = await marketingCtx();
    const visible = NAV_ITEMS.filter((i) =>
      can(ctx, i.requiredPermission, { organizationId: orgId }),
    )
      .map((i) => i.id)
      .sort();
    expect(visible).not.toContain('patients');
    // Analytics is what the role is for — it must not have been collateral.
    expect(visible).toContain('analytics');
  });

  it('is refused the customers list by direct URL, not merely hidden', async () => {
    await asMarketing();
    const res = await routeList.GET(req('http://localhost/api/customers'));
    expect(res.status).toBe(403);
  });

  it('is refused a single customer record by direct URL', async () => {
    await asMarketing();
    const res = await routeOne.GET(req(`http://localhost/api/customers/${customerId}`), {
      params: Promise.resolve({ id: customerId }),
    });
    expect(res.status).toBe(403);
  });

  it('is refused search, which would otherwise leak contact details', async () => {
    await asMarketing();
    const res = await routeList.GET(req('http://localhost/api/customers?q=a'));
    expect(res.status).toBe(403);
  });

  it('cross-tenant: denied against another organization too', async () => {
    const ctx = await marketingCtx();
    expect(can(ctx, 'client.read:contact', { organizationId: otherOrgId })).toBe(false);
    expect(can(ctx, 'report.branch', { organizationId: otherOrgId })).toBe(false);
  });

  // Complement: the roles that legitimately need patient contact data must be
  // untouched, or this would be an outage rather than least privilege.
  it('ORG_OWNER still reads the customers list', async () => {
    await asOwner();
    const res = await routeList.GET(req('http://localhost/api/customers'));
    expect(res.status).toBe(200);
  });

  it('ORG_OWNER still reads a single customer record', async () => {
    await asOwner();
    const res = await routeOne.GET(req(`http://localhost/api/customers/${customerId}`), {
      params: Promise.resolve({ id: customerId }),
    });
    expect(res.status).toBe(200);
  });

  it('every clinical role keeps client.read:contact', async () => {
    const rows = await unsafePrismaAdmin.role.findMany({
      where: {
        organizationId: null,
        key: {
          in: [
            'ORG_OWNER',
            'ORG_ADMIN',
            'BRANCH_MANAGER',
            'SENIOR_PROVIDER',
            'FRONT_DESK',
            'PROVIDER',
          ],
        },
      },
      select: { key: true, permissions: { select: { permissionKey: true } } },
    });
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(
        r.permissions.map((p) => p.permissionKey),
        `${r.key} lost client.read:contact`,
      ).toContain('client.read:contact');
    }
  });
});
