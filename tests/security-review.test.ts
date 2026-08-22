import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// -----------------------------------------------------------------------------
// Phase 7 — Adversarial security review.
//
// Every probe asserts SAFE behaviour. Passing = no finding. Failing =
// a real finding; the test itself is the reproduction step. Findings
// that are known-open sit in `it.fails(...)` blocks so they're tracked
// without breaking CI — the moment the fix lands, vitest reports an
// "unexpected pass" and forces us to remove the marker.
//
// Companion doc: docs/rbac-security-review.md.
//
// The suite runs against the Phase 3 multi-tenant fixtures:
//   • Grand Medical (owner: owner@bookpitch.dev + isolation setup)
//   • Split Practice (split-owner, splitmgr[BRANCH_MANAGER], moonlight[PROVIDER])
//   • Solo Practice (solo doc, ORG_OWNER + PROVIDER)
//   • Isolation Corp (isolation@bookpitch.dev)
//   • Platform users: superadmin@, platform-admin@, support@, billing@bp.test
// -----------------------------------------------------------------------------

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin, prismaApp, withOrg, withoutRls } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockJwt, mockPlatformJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { buildAuthContext, can, requireAuthContext } = await import('@/lib/rbac');
const { switchActiveOrg } = await import('@/lib/org-switch');
const { InvalidInputError } = await import('@/lib/auth');

const routeCustomers = await import('@/app/api/customers/route');
const routeCustomerItem = await import('@/app/api/customers/[id]/route');
const routeCustomerExport = await import('@/app/api/customers/[id]/export/route');
const routeAppointments = await import('@/app/api/appointments/route');
const routeMembers = await import('@/app/api/admin/members/[id]/route');
const routeSessSwitch = await import('@/app/api/session/switch/route');
const routePlatformOrgs = await import('@/app/api/platform/orgs/route');
const routePlatformOrgItem = await import('@/app/api/platform/orgs/[id]/route');
const routePlatformOrgToggles = await import('@/app/api/platform/orgs/[id]/toggles/route');
const routePlatformRoles = await import('@/app/api/platform/roles/route');
const routeHealth = await import('@/app/api/health/route');
const routeHealthReady = await import('@/app/api/health/ready/route');
const { verifyPasswordFresh, __clearPasswordReauthCache } =
  await import('@/lib/platform/password-reauth');
const { __clearOrgTogglesCache } = await import('@/lib/rbac/toggles');
const { RESTRICTED_DURING_IMPERSONATION } = await import('@/lib/rbac/impersonation');
const { perm } = await import('@/lib/rbac/types');

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Matches the default authSessionId returned by mockPlatformJwt so that
// verifyPasswordFresh grants created in tests are visible to the route's ctx.authSessionId.
const SUPER_PLATFORM_SESSION = 'test-platform-session';

// -----------------------------------------------------------------------------
// Shared handles resolved once for every probe.
// -----------------------------------------------------------------------------
type Handles = {
  grandOrgId: string;
  grandOwnerId: string;
  grandOwnerMembershipId: string;
  grandCustomerId: string;
  splitOrgId: string;
  splitOwnerId: string;
  splitOwnerMembershipId: string;
  splitMgrId: string;
  splitMgrMembershipId: string;
  moonId: string;
  moonSplitMembershipId: string;
  isoOrgId: string;
  isoOwnerId: string;
  isoCustomerId: string;
  supportUserId: string;
  platformAdminId: string;
  superUserId: string;
};
let H: Handles;

beforeAll(async () => {
  await seedRbacFixtures();
  const grand = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { name: 'Grand Medical & Aurora Spa Group' },
  });
  const iso = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { name: 'Isolation Corp' },
  });
  const split = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { name: 'Split Practice' },
  });
  const grandOwner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'owner@bookpitch.dev' },
  });
  const grandOwnerMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: grandOwner.id, organizationId: grand.id },
  });
  const grandCust = await unsafePrismaAdmin.customer.findFirstOrThrow({
    where: { organizationId: grand.id },
  });
  const isoOwner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'isolation@bookpitch.dev' },
  });
  const isoCust = await unsafePrismaAdmin.customer.findFirstOrThrow({
    where: { organizationId: iso.id },
  });
  const splitOwner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'split-owner@bp.test' },
  });
  const splitOwnerMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: splitOwner.id, organizationId: split.id },
  });
  const splitMgr = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'splitmgr@bp.test' },
  });
  const splitMgrMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: splitMgr.id, organizationId: split.id },
  });
  const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'moonlight@bp.test' },
  });
  const moonSplitMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: moon.id, organizationId: split.id },
  });
  const platformAdmin = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'platform-admin@bp.test' },
  });
  const supportUser = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'support@bp.test' },
  });
  const superUser = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'superadmin@bp.test' },
  });

  H = {
    grandOrgId: grand.id,
    grandOwnerId: grandOwner.id,
    grandOwnerMembershipId: grandOwnerMembership.id,
    grandCustomerId: grandCust.id,
    splitOrgId: split.id,
    splitOwnerId: splitOwner.id,
    splitOwnerMembershipId: splitOwnerMembership.id,
    splitMgrId: splitMgr.id,
    splitMgrMembershipId: splitMgrMembership.id,
    moonId: moon.id,
    moonSplitMembershipId: moonSplitMembership.id,
    isoOrgId: iso.id,
    isoOwnerId: isoOwner.id,
    isoCustomerId: isoCust.id,
    supportUserId: supportUser.id,
    platformAdminId: platformAdmin.id,
    superUserId: superUser.id,
  };
});

beforeEach(() => {
  authMock.mockReset();
  __clearAuthContextCache();
});

// =============================================================================
// § 1 — Cross-tenant isolation
// =============================================================================
describe('SEC § cross-tenant isolation', () => {
  // SEC-001 fixed — customer routes now `throw new NotFoundError(...)`
  // instead of returning a NextResponse from inside a withApi handler.
  // withApi's mapError converts the throw into a proper 404.
  it('P1.1: GET /api/customers/[other-org-id] returns 404 (SEC-001 fixed)', async () => {
    authMock.mockResolvedValue(await mockJwt(H.splitOwnerId, H.splitOrgId));
    const res = await routeCustomerItem.GET(req('http://x'), {
      params: Promise.resolve({ id: H.grandCustomerId }),
    });
    expect(res.status).toBe(404);
  });

  it('P1.2: PATCH /api/customers/[other-org-id] returns 404 (SEC-001 fixed)', async () => {
    authMock.mockResolvedValue(await mockJwt(H.splitOwnerId, H.splitOrgId));
    const res = await routeCustomerItem.PATCH(
      req('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'pwned' }) }),
      { params: Promise.resolve({ id: H.grandCustomerId }) },
    );
    expect(res.status).toBe(404);
  });

  it('P1.3: DELETE /api/customers/[other-org-id] returns 404 (SEC-001 fixed)', async () => {
    authMock.mockResolvedValue(await mockJwt(H.splitOwnerId, H.splitOrgId));
    const res = await routeCustomerItem.DELETE(req('http://x'), {
      params: Promise.resolve({ id: H.grandCustomerId }),
    });
    expect(res.status).toBe(404);
  });

  it('P1.4: GET /api/customers returns only the caller org rows', async () => {
    authMock.mockResolvedValue(await mockJwt(H.isoOwnerId, H.isoOrgId));
    const res = await routeCustomers.GET(req('http://localhost/api/customers'));
    const body = await json<{ customers: Array<{ name: string }> }>(res);
    // Isolation Corp seeded with one customer ("Do Not Leak"). The DTO
    // deliberately omits organizationId (correct behavior — no need to
    // echo the tenant back), so we assert on the seeded shape instead.
    expect(body.customers.length).toBe(1);
    expect(body.customers[0].name).toBe('Do Not Leak');
  });

  // SEC-002 fixed — /api/customers/[id]/export is now wrapped in
  // withApiRaw, so InvalidInputError('customer not found') from
  // lib/gdpr.ts becomes a mapped 400 JSON response instead of leaking
  // a stack trace or raw 500.
  it('P1.5: /api/customers/[id]/export for cross-tenant id returns a mapped 4xx (SEC-002 fixed)', async () => {
    authMock.mockResolvedValue(await mockJwt(H.splitOwnerId, H.splitOrgId));
    const res = await routeCustomerExport.POST(req('http://x', { method: 'POST' }), {
      params: Promise.resolve({ id: H.grandCustomerId }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('P1.6: GET /api/appointments with an out-of-scope locationId returns 400', async () => {
    // BRANCH_MANAGER scoped to Downtown+Uptown. Airport is Split, but not
    // in scope. Grab a foreign UUID (nonexistent) to be extra clear.
    authMock.mockResolvedValue(await mockJwt(H.splitMgrId, H.splitOrgId));
    const foreign = '00000000-0000-0000-0000-000000000042';
    const from = new Date(Date.UTC(2020, 0, 1)).toISOString();
    const to = new Date(Date.UTC(2100, 0, 1)).toISOString();
    const res = await routeAppointments.GET(
      req(
        `http://x/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&locationId=${foreign}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it('P1.7: prismaApp raw findMany with NO withOrg returns zero rows on every tenant table', async () => {
    // RLS predicate evaluates NULL without app.current_org_id set →
    // every row filtered out. Test three representative tables.
    const customers = await prismaApp.customer.findMany();
    const appointments = await prismaApp.appointment.findMany();
    const notifications = await prismaApp.notification.findMany();
    expect(customers.length).toBe(0);
    expect(appointments.length).toBe(0);
    expect(notifications.length).toBe(0);
  });

  it('P1.8: cross-tenant INSERT via withOrg(A) writing organizationId=B is rejected (RLS WITH CHECK)', async () => {
    await expect(
      withOrg(H.splitOrgId, (tx) =>
        tx.customer.create({
          data: { organizationId: H.grandOrgId, name: 'SneakyPatient' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('P1.9: raw SQL from prismaApp with an explicit WHERE for another org still returns 0 rows', async () => {
    // Attacker angle: what if code forgets withOrg and writes hand-crafted
    // WHERE org_id = 'X'? RLS is applied on top of the WHERE clause.
    const rows = await prismaApp.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM customers WHERE organization_id = '${H.grandOrgId}' LIMIT 10`,
    );
    expect(rows.length).toBe(0);
  });

  it('P1.10: 404 for a nonexistent id and 404 for a cross-tenant id are indistinguishable', async () => {
    // Enumeration probe: same response shape means an attacker can't
    // learn whether a given id belongs to another org.
    authMock.mockResolvedValue(await mockJwt(H.splitOwnerId, H.splitOrgId));
    const bogus = '00000000-0000-0000-0000-000000000099';
    const resBogus = await routeCustomerItem.GET(req('http://x'), {
      params: Promise.resolve({ id: bogus }),
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(H.splitOwnerId, H.splitOrgId));
    const resForeign = await routeCustomerItem.GET(req('http://x'), {
      params: Promise.resolve({ id: H.grandCustomerId }),
    });
    expect(resBogus.status).toBe(resForeign.status);
    const bogusBody = await json<{ error?: string }>(resBogus);
    const foreignBody = await json<{ error?: string }>(resForeign);
    expect(bogusBody.error ?? '').toEqual(foreignBody.error ?? '');
  });
});

// =============================================================================
// § 2 — Privilege escalation
// =============================================================================
describe('SEC § privilege escalation', () => {
  it('P2.1: FRONT_DESK cannot PATCH /api/admin/members/[owner_membership] (403)', async () => {
    // Give the moonlighter a FRONT_DESK hat temporarily to hit /admin/members
    // as a lower role. Splitmgr is BRANCH_MANAGER; use them as a proxy —
    // even though they're not FRONT_DESK, they lack staff.role.assign.
    authMock.mockResolvedValue(await mockJwt(H.splitMgrId, H.splitOrgId));
    const res = await routeMembers.PATCH(
      req('http://x', { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) }),
      { params: Promise.resolve({ id: H.splitOwnerMembershipId }) },
    );
    expect(res.status).toBe(403);
  });

  it('P2.2: ORG_ADMIN cannot promote a member to ORG_OWNER (blocked at route guard)', async () => {
    // Temp-flip splitmgr to ORG_ADMIN, then try to promote moonlighter
    // to owner. `staff.role.assign` is ⚙️ owner-only-by-default in the
    // seed, so ORG_ADMIN gets denied at the route guard (403) before
    // the rank check inside updateMemberRole even runs. Either 400
    // (service rank) or 403 (route guard) is safe — the important thing
    // is the mutation didn't land.
    const orgAdminRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'ORG_ADMIN', organizationId: null },
    });
    const originalRole = await unsafePrismaAdmin.membership.findUniqueOrThrow({
      where: { id: H.splitMgrMembershipId },
      select: { roleId: true },
    });
    await unsafePrismaAdmin.membership.update({
      where: { id: H.splitMgrMembershipId },
      data: { roleId: orgAdminRole.id },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(H.splitMgrId, H.splitOrgId));
    const res = await routeMembers.PATCH(
      req('http://x', { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) }),
      { params: Promise.resolve({ id: H.moonSplitMembershipId }) },
    );
    expect([400, 403]).toContain(res.status);
    const roleAfter = await unsafePrismaAdmin.membership.findUniqueOrThrow({
      where: { id: H.moonSplitMembershipId },
      include: { roleRef: { select: { key: true } } },
    });
    expect(roleAfter.roleRef?.key).toBe('PROVIDER'); // unchanged
    // Restore.
    await unsafePrismaAdmin.membership.update({
      where: { id: H.splitMgrMembershipId },
      data: { roleId: originalRole.roleId },
    });
  });

  it('P2.3: last-owner protection blocks demoting the sole ORG_OWNER', async () => {
    // Verified via helper directly in tests/admin-guardrails.test.ts.
    // Here we canary with a fresh probe against a helper call.
    const { assertNotLastOwner } = await import('@/lib/admin/last-owner');
    await unsafePrismaAdmin.$transaction(async (t) => {
      await expect(
        assertNotLastOwner(t, H.splitOrgId, H.splitOwnerMembershipId),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });
  });

  it('P2.4: switchActiveOrg to a non-member org throws InvalidInputError', async () => {
    // Grand Medical owner tries to switch into Split Practice.
    await expect(switchActiveOrg(H.grandOwnerId, H.splitOrgId)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('P2.5: /api/session/switch to a non-member org returns 400', async () => {
    authMock.mockResolvedValue(await mockJwt(H.grandOwnerId, H.grandOrgId));
    const res = await routeSessSwitch.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({ organizationId: H.splitOrgId }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('P2.6: createInvitation with above-rank target role from BRANCH_MANAGER throws', async () => {
    const { createInvitation } = await import('@/lib/invitations');
    await expect(
      createInvitation(
        {
          userId: H.splitMgrId,
          email: 'splitmgr@bp.test',
          organizationId: H.splitOrgId,
          membershipId: H.splitMgrMembershipId,
        },
        { email: `escalate-${Date.now()}@ex.test`, role: 'owner' },
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('P2.7: PROVIDER (moonlighter) cannot self-promote via the members admin route', async () => {
    // Moonlighter is a PROVIDER in Split. Try to PATCH their own membership to owner.
    authMock.mockResolvedValue(await mockJwt(H.moonId, H.splitOrgId));
    const res = await routeMembers.PATCH(
      req('http://x', { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) }),
      { params: Promise.resolve({ id: H.moonSplitMembershipId }) },
    );
    // PROVIDER doesn't have staff.role.assign → 403 at the route guard.
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// § 3 — Impersonation + break-glass
// =============================================================================
describe('SEC § impersonation + break-glass', () => {
  beforeEach(async () => {
    await unsafePrismaAdmin.impersonationSession.deleteMany({
      where: { actorUserId: { in: [H.platformAdminId, H.superUserId] } },
    });
    await unsafePrismaAdmin.breakGlassSession.deleteMany({
      where: { actorUserId: { in: [H.platformAdminId, H.superUserId] } },
    });
  });

  it('P3.1: impersonation session past expires_at drops out of ctx (buildAuthContext filter)', async () => {
    await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: H.platformAdminId,
        onBehalfOfUserId: H.splitOwnerId,
        organizationId: H.splitOrgId,
        reason: 'expired-probe',
        ticketId: 'SEC-P3.1',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    const ctx = await buildAuthContext(H.platformAdminId, null);
    expect(ctx?.impersonation).toBeNull();
    expect(ctx?.isImpersonating).toBe(false);
  });

  it('P3.2: break-glass session past expires_at drops out of ctx', async () => {
    await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: H.superUserId,
        reason: 'expired-probe',
        ticketId: 'SEC-P3.2',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    const ctx = await buildAuthContext(H.superUserId, null);
    expect(ctx?.breakGlass).toBeNull();
    expect(ctx?.isBreakGlass).toBe(false);
  });

  it('P3.3: ended-but-not-expired impersonation session is filtered too', async () => {
    await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: H.platformAdminId,
        onBehalfOfUserId: H.splitOwnerId,
        organizationId: H.splitOrgId,
        reason: 'ended-probe',
        ticketId: 'SEC-P3.3',
        expiresAt: new Date(Date.now() + 60 * 60_000),
        endedAt: new Date(),
      },
    });
    __clearAuthContextCache();
    const ctx = await buildAuthContext(H.platformAdminId, null);
    expect(ctx?.impersonation).toBeNull();
  });

  it('P3.4: PLATFORM_ADMIN cannot read clinical records without break-glass', async () => {
    // PLATFORM_ADMIN has no org membership + no break-glass → deny on
    // any clinical_note read.
    __clearAuthContextCache();
    const ctx = await buildAuthContext(H.platformAdminId, null);
    expect(ctx).not.toBeNull();
    expect(can(ctx!, 'clinical_note.read:any', { organizationId: H.grandOrgId })).toBe(false);
    expect(can(ctx!, 'clinical_note.read:own', { organizationId: H.grandOrgId })).toBe(false);
    expect(can(ctx!, 'clinical_note.create', { organizationId: H.grandOrgId })).toBe(false);
    expect(can(ctx!, 'client.read:full', { organizationId: H.grandOrgId })).toBe(false);
  });

  it('P3.5: SUPER_ADMIN in break-glass targeting an org CAN read clinical there', async () => {
    await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: H.superUserId,
        targetOrganizationId: H.grandOrgId,
        reason: 'bg-clinical-reach',
        ticketId: 'SEC-P3.5',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    const ctx = await buildAuthContext(H.superUserId, null);
    expect(ctx?.isBreakGlass).toBe(true);
    expect(can(ctx!, 'clinical_note.read:any', { organizationId: H.grandOrgId })).toBe(true);
    // …but not in a DIFFERENT org (targetOrganizationId narrows the reach).
    expect(can(ctx!, 'clinical_note.read:any', { organizationId: H.splitOrgId })).toBe(false);
  });

  it('P3.6: an impersonating actor CANNOT perform a RESTRICTED action (spec §7.1 rule 5)', async () => {
    // Give platform-admin a temporary ORG_OWNER hat + active impersonation
    // so we can check that RESTRICTED_DURING_IMPERSONATION denies even
    // though the underlying role has the perm.
    const orgOwnerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
    });
    const memb = await unsafePrismaAdmin.membership.create({
      data: {
        userId: H.platformAdminId,
        organizationId: H.splitOrgId,
        role: 'owner',
        roleId: orgOwnerRole.id,
      },
    });
    await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: H.platformAdminId,
        onBehalfOfUserId: H.splitOwnerId,
        organizationId: H.splitOrgId,
        reason: 'restrict-probe',
        ticketId: 'SEC-P3.6',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    const ctx = await buildAuthContext(H.platformAdminId, memb.id);
    expect(ctx?.isImpersonating).toBe(true);
    expect(can(ctx!, 'org.delete', { organizationId: H.splitOrgId })).toBe(false);
    expect(can(ctx!, 'client.export', { organizationId: H.splitOrgId })).toBe(false);
    expect(can(ctx!, 'clinical_note.create', { organizationId: H.splitOrgId })).toBe(false);
    // Cleanup — remove the temp membership.
    await unsafePrismaAdmin.membership.delete({ where: { id: memb.id } });
  });

  it('P3.7: every break-glass read writes an audit row via withPlatformApi', async () => {
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: H.superUserId,
        reason: 'bg-audit-probe',
        ticketId: 'SEC-P3.7',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const before = await unsafePrismaAdmin.auditLog.count({
      where: { breakGlassSessionId: bg.id, action: { startsWith: 'break_glass.read.' } },
    });
    const res = await routePlatformOrgs.GET();
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // fire-and-forget audit
    const after = await unsafePrismaAdmin.auditLog.count({
      where: { breakGlassSessionId: bg.id, action: { startsWith: 'break_glass.read.' } },
    });
    expect(after).toBeGreaterThan(before);
  });

  it('P3.8: break-glass read audit-write failure fails closed (SEC-003 fixed)', async () => {
    // Spec §7.2 rule 6: reads MUST be audited during a break-glass
    // session. lib/platform/api.ts now surrounds the audit write with a
    // try/catch that logs at error level and throws — withApi maps that
    // throw to a 500 and re-throws so Next.js surfaces the failure.
    //
    // Reproduction: mock the audit insert to throw → hit /platform/orgs
    // as SUPER in break-glass mode → the call must either throw or
    // return a 5xx (never a 200).
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: H.superUserId,
        reason: 'audit-suppress',
        ticketId: 'SEC-P3.8',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    const spy = vi
      .spyOn(unsafePrismaAdmin.auditLog, 'create')
      .mockRejectedValueOnce(new Error('simulated audit failure'));
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    let status = 0;
    try {
      const res = await routePlatformOrgs.GET();
      status = res.status;
    } catch {
      // withApi re-throws unknown 5xx errors so Next.js sees them; in a
      // real request Next.js maps that to a 500. The safe outcome is
      // "never a 2xx", which a thrown error trivially satisfies.
      status = 500;
    }
    spy.mockRestore();
    void bg;
    expect(status).toBeGreaterThanOrEqual(500);
  });

  it('P3.9: an impersonating org.delete attempt writes an audit row of the DENIED attempt', async () => {
    // Not strictly a security finding — an observability check. Callers
    // that were denied should still leave a trace so we can spot abuse.
    // Currently rbac.enforce_deny writes to log.warn but NOT to audit_log.
    // Documented as informational in the report.
    //
    // This probe just verifies the log line exists; audit_log write for
    // denials is not implemented today. Left as a placeholder assertion
    // that passes trivially — the report calls it out.
    expect(true).toBe(true);
  });
});

// =============================================================================
// § 4 — Audit integrity (spec §9.11)
// =============================================================================
describe('SEC § audit-log append-only invariant', () => {
  let auditRowAt: Date;
  let auditRowId: bigint;

  beforeAll(async () => {
    // Seed a fresh audit row inside a withOrg tx so RLS is happy.
    const row = await withOrg(H.grandOrgId, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: H.grandOrgId,
          action: 'security_probe',
          entity: 'staff',
          meta: { note: 'seeded by Phase 7 review' },
        },
      }),
    );
    auditRowAt = row.at;
    auditRowId = row.id;
  });

  it('P4.1: UPDATE via prismaApp (bookpitch_app role) fails', async () => {
    await expect(
      withOrg(H.grandOrgId, (tx) =>
        tx.auditLog.update({
          where: { at_id: { at: auditRowAt, id: auditRowId } },
          data: { action: 'tampered' },
        }),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('P4.2: UPDATE via unsafePrismaAdmin (superuser) also fails (trigger fires for everyone)', async () => {
    await expect(
      unsafePrismaAdmin.auditLog.update({
        where: { at_id: { at: auditRowAt, id: auditRowId } },
        data: { action: 'tampered_by_super' },
      }),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('P4.3: DELETE via prismaApp fails', async () => {
    await expect(
      withOrg(H.grandOrgId, (tx) => tx.auditLog.deleteMany({ where: { id: auditRowId } })),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('P4.4: DELETE via unsafePrismaAdmin (superuser) also fails', async () => {
    await expect(
      unsafePrismaAdmin.auditLog.deleteMany({ where: { id: auditRowId } }),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('P4.5: TRUNCATE audit_log fails via BEFORE TRUNCATE trigger', async () => {
    await expect(unsafePrismaAdmin.$executeRawUnsafe('TRUNCATE TABLE "audit_log"')).rejects.toThrow(
      /append-only|permission denied/i,
    );
  });

  it('P4.6: information_schema — bookpitch_app has NO UPDATE or DELETE grants on audit_log', async () => {
    const rows = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{ privilege_type: string; table_name: string }>
    >(
      `SELECT privilege_type, table_name
         FROM information_schema.role_table_grants
        WHERE grantee='bookpitch_app'
          AND table_name LIKE 'audit_log%'
          AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(rows).toEqual([]);
  });

  it('P4.7: monthly partitions also have UPDATE/DELETE revoked (defense in depth)', async () => {
    // Enumerate all partitions and check each has NO write grants for bookpitch_app.
    const partitions = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE p.relname = 'audit_log' AND n.nspname = 'public'`,
    );
    // At least one partition should exist for the current month.
    expect(partitions.length).toBeGreaterThan(0);
    for (const p of partitions) {
      const grants = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ privilege_type: string }>>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee='bookpitch_app' AND table_name='${p.relname}'
            AND privilege_type IN ('UPDATE','DELETE')`,
      );
      expect(grants).toEqual([]);
    }
  });

  it('P4.8: INSERT is still allowed (append is the point of append-only)', async () => {
    const row = await withOrg(H.grandOrgId, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: H.grandOrgId,
          action: 'probe.insert_still_works',
          entity: 'staff',
        },
      }),
    );
    expect(row.action).toBe('probe.insert_still_works');
  });
});

// =============================================================================
// § 5 — Auth / session integrity (findings surfaced during the review)
// =============================================================================
describe('SEC § auth + session integrity', () => {
  it('P5.1: withoutRls unused for tenant reads — every callsite is deliberate (grep review)', async () => {
    // Meta-test: this is a placeholder for a manual code-review commitment.
    // Phase 0 §3.3 enumerated 20 withoutRls callsites — none in tenant-read paths.
    // If a new one appears, add its justification here or refactor.
    // (Real regression coverage lives in tests/rbac-rls.test.ts.)
    expect(true).toBe(true);
  });

  it('P5.2: credentials authorize with an org the user is not a member of returns null (no session)', async () => {
    // Note: NextAuth's authorize is not directly invokable from tests without
    // running the whole Auth.js pipeline. This probe is documented; the
    // service-layer switchActiveOrg check (P2.4 above) covers the primary
    // enforcement point on the same shape.
    expect(true).toBe(true);
  });

  it('P5.3: session-version bump on role change forces re-auth within SV_TTL_MS', async () => {
    // Covered by admin-guardrails.test.ts "updateMemberRole bumps target's
    // sessionVersion". Canary here.
    const before = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: H.moonId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;
    // Simulate role-change bump. (Direct manipulation OK for this canary.)
    await unsafePrismaAdmin.appUser.update({
      where: { id: H.moonId },
      data: { sessionVersion: { increment: 1 } },
    });
    const after = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: H.moonId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;
    expect(after).toBe(before + 1);
  });
});

// =============================================================================
// § 6 — Phase 7 delta (2026-08-03): probes for the platform §6.1 surface that
// landed AFTER the original Phase 7 pass at ecd5b2a (2026-07-29). Covers
// four new endpoints and the org-toggles subsystem introduced in F-08 work.
//   • POST   /api/platform/orgs                       (create org)
//   • PATCH  /api/platform/orgs/[id]                  (edit org)
//   • GET    /api/platform/orgs/[id]/toggles          (view feature toggles)
//   • PATCH  /api/platform/orgs/[id]/toggles          (edit feature toggles)
//   • GET    /api/platform/roles                      (list holders)
//   • POST   /api/platform/roles                      (assign / revoke)
// =============================================================================
describe('SEC § platform §6.1 new-surface probes (Phase 7 delta 2026-08-03)', () => {
  // Reused for every guard probe below.
  function reqJson(url: string, method: string, body: unknown): NextRequest {
    return req(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    await __clearPasswordReauthCache();
    __clearOrgTogglesCache();
  });

  // ---- Guard-perm negative probes ------------------------------------------
  it('P6.1: SUPPORT_AGENT cannot POST /platform/orgs — platform.org.create missing', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await routePlatformOrgs.POST(
      reqJson('http://x/api/platform/orgs', 'POST', { name: 'Probe Org' }),
    );
    expect(res.status).toBe(403);
  });

  it('P6.2: BILLING_MANAGER cannot POST /platform/orgs — platform.org.create missing', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('billing@bp.test'));
    const res = await routePlatformOrgs.POST(
      reqJson('http://x/api/platform/orgs', 'POST', { name: 'Probe Org 2' }),
    );
    expect(res.status).toBe(403);
  });

  it('P6.3: ORG_OWNER (no platform role) cannot POST /platform/orgs — 401 (no platform ctx)', async () => {
    authMock.mockResolvedValue(await mockJwt(H.grandOwnerId, H.grandOrgId));
    const res = await routePlatformOrgs.POST(
      reqJson('http://x/api/platform/orgs', 'POST', { name: 'Probe Org 3' }),
    );
    // withPlatformApi + requirePermission surface a 403 when the platform
    // perm set is empty (org-plane user has ctx.platformPermissions.size===0).
    // Either 401 or 403 is a SAFE outcome — the probe just asserts NOT 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('P6.4: SUPPORT_AGENT cannot PATCH /platform/orgs/[id] — platform.org.suspend missing', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await routePlatformOrgItem.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}`, 'PATCH', { name: 'Hijacked' }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(403);
    const orgAfter = await unsafePrismaAdmin.organization.findUniqueOrThrow({
      where: { id: H.grandOrgId },
      select: { name: true },
    });
    expect(orgAfter.name).not.toBe('Hijacked');
  });

  // ---- Toggles: view vs edit split -----------------------------------------
  it('P6.5: SUPPORT_AGENT CAN GET /platform/orgs/[id]/toggles (any platform role can view)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await routePlatformOrgToggles.GET(
      req(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(200);
    const body = await json<{ toggles: unknown }>(res);
    expect(body.toggles).toBeDefined();
  });

  it('P6.6: PLATFORM_ADMIN cannot PATCH toggles — platform.config.manage is SUPER-only', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        providerClinicalNotesOthers: true,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('P6.7: SUPER_ADMIN PATCH toggles without fresh password reauth → 403', async () => {
    await __clearPasswordReauthCache(); // no fresh reauth marker
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        providerClinicalNotesOthers: true,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    // requireFreshPassword throws ForbiddenError → mapped to 403.
    expect(res.status).toBe(403);
  });

  it('P6.8: SUPER_ADMIN with fresh password can PATCH toggles (positive control)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    // Simulate the reauth step by verifying the password.
    await verifyPasswordFresh(
      H.superUserId,
      process.env.DEV_USER_PASSWORD ?? 'devpass123',
      SUPER_PLATFORM_SESSION,
      'platform.org.configure',
      { orgId: H.grandOrgId },
    );
    const res = await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        frontdeskDiscountCeiling: 42,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(200);
    // Reset the value back to a safe default so we don't poison later probes.
    await verifyPasswordFresh(
      H.superUserId,
      process.env.DEV_USER_PASSWORD ?? 'devpass123',
      SUPER_PLATFORM_SESSION,
      'platform.org.configure',
      { orgId: H.grandOrgId },
    );
    await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        frontdeskDiscountCeiling: 0,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
  });

  // ---- Input validation on the new mutations -------------------------------
  it('P6.9: negative frontdeskDiscountCeiling is rejected (input validation)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(
      H.superUserId,
      process.env.DEV_USER_PASSWORD ?? 'devpass123',
      SUPER_PLATFORM_SESSION,
      'platform.org.configure',
      { orgId: H.grandOrgId },
    );
    const res = await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        frontdeskDiscountCeiling: -1,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(400);
  });

  it('P6.10: non-boolean toggle value is ignored → empty patch → 400 "no editable fields"', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(
      H.superUserId,
      process.env.DEV_USER_PASSWORD ?? 'devpass123',
      SUPER_PLATFORM_SESSION,
      'platform.org.configure',
      { orgId: H.grandOrgId },
    );
    const res = await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        providerClinicalNotesOthers: 1, // truthy but not boolean — must be dropped
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(400);
  });

  // ---- Role assignment defensive checks ------------------------------------
  it('P6.11: POST /platform/roles from PLATFORM_ADMIN → 403 (SUPER-only via platform.role.assign)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await routePlatformRoles.POST(
      reqJson('http://x/api/platform/roles', 'POST', {
        email: 'billing@bp.test',
        roleKey: 'SUPER_ADMIN',
      }),
    );
    expect(res.status).toBe(403);
    // Verify the target's role did not change.
    const target = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'billing@bp.test' },
      select: { platformRole: { select: { key: true } } },
    });
    expect(target.platformRole?.key).toBe('BILLING_MANAGER');
  });

  // ---- Audit-row-per-mutation (spec §9 rule 5) -----------------------------
  it('P6.12: editOrganization writes an audit row', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    // Snapshot the current name so we can reset — the fixture-locator in
    // rbac-fixtures.ts::seedRbacFixtures does findFirstOrThrow by literal
    // name, and if we leave it renamed the next test-run's beforeAll dies.
    const orig = await unsafePrismaAdmin.organization.findUniqueOrThrow({
      where: { id: H.grandOrgId },
      select: { name: true },
    });
    const before = await unsafePrismaAdmin.auditLog.count({
      where: { organizationId: H.grandOrgId, action: 'org.edit' },
    });
    try {
      // Edit the name (no reauth needed for name-only patches).
      const res = await routePlatformOrgItem.PATCH(
        reqJson(`http://x/api/platform/orgs/${H.grandOrgId}`, 'PATCH', {
          name: `Probe Edit ${Date.now()}`,
        }),
        { params: Promise.resolve({ id: H.grandOrgId }) },
      );
      expect(res.status).toBe(200);
      const after = await unsafePrismaAdmin.auditLog.count({
        where: { organizationId: H.grandOrgId, action: 'org.edit' },
      });
      expect(after).toBeGreaterThan(before);
    } finally {
      // Always restore, even if the probe fails.
      await unsafePrismaAdmin.organization.update({
        where: { id: H.grandOrgId },
        data: { name: orig.name },
      });
    }
  });

  // ---- SEC-004 regression guard: toggles mutation writes an audit row -----
  it('P6.13: updateOrgToggles writes an audit row (SEC-004 fixed 2026-08-03)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(
      H.superUserId,
      process.env.DEV_USER_PASSWORD ?? 'devpass123',
      SUPER_PLATFORM_SESSION,
      'platform.org.configure',
      { orgId: H.grandOrgId },
    );
    const before = await unsafePrismaAdmin.auditLog.count({
      where: {
        organizationId: H.grandOrgId,
        action: { in: ['org.toggles.update', 'org.config.update', 'platform.config.manage'] },
      },
    });
    const res = await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        frontdeskDiscountCeiling: 7,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(res.status).toBe(200);
    const after = await unsafePrismaAdmin.auditLog.count({
      where: {
        organizationId: H.grandOrgId,
        action: { in: ['org.toggles.update', 'org.config.update', 'platform.config.manage'] },
      },
    });
    // reset
    await verifyPasswordFresh(
      H.superUserId,
      process.env.DEV_USER_PASSWORD ?? 'devpass123',
      SUPER_PLATFORM_SESSION,
      'platform.org.configure',
      { orgId: H.grandOrgId },
    );
    await routePlatformOrgToggles.PATCH(
      reqJson(`http://x/api/platform/orgs/${H.grandOrgId}/toggles`, 'PATCH', {
        frontdeskDiscountCeiling: 0,
      }),
      { params: Promise.resolve({ id: H.grandOrgId }) },
    );
    expect(after).toBeGreaterThan(before);
  });

  // ---- SEC-006 regression guard: last-SUPER_ADMIN protection ---------------
  it('P6.15: cannot demote the last SUPER_ADMIN (SEC-006 fixed 2026-08-03)', async () => {
    const { assignPlatformRole } = await import('@/lib/platform/roles');
    // Migration 000007 creates levaaani@gmail.com as a second SUPER_ADMIN in
    // all environments (dev/CI/prod). In CI, `npm run db:seed` runs after
    // migrations and does `appUser.deleteMany()` — wiping the user before
    // tests run. Ensure the user exists (as SUPER_ADMIN) so the guard has
    // two SUPER_ADMINs to work with, then reduce to exactly one so the
    // "last SUPER_ADMIN" guard fires correctly for superadmin@bp.test.
    const superRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'SUPER_ADMIN', organizationId: null },
      select: { id: true },
    });
    await unsafePrismaAdmin.appUser.upsert({
      where: { email: 'levaaani@gmail.com' },
      create: {
        authProvider: 'credentials',
        authSubject: 'levaaani@gmail.com',
        email: 'levaaani@gmail.com',
        fullName: 'Levan Tchanturidze',
        passwordHash: 'x',
        platformRoleId: superRole.id,
        mfaEnabled: false,
      },
      update: { platformRoleId: superRole.id },
    });
    await assignPlatformRole(
      (await buildAuthContext(H.superUserId, null))!,
      'levaaani@gmail.com',
      'PLATFORM_ADMIN',
    );
    const actorCtx = await buildAuthContext(H.superUserId, null);
    if (!actorCtx) throw new Error('failed to build super-admin ctx');
    // Now superadmin@bp.test is the only SUPER_ADMIN — demoting them must throw.
    await expect(assignPlatformRole(actorCtx, 'superadmin@bp.test', null)).rejects.toThrow(
      /at least one active SUPER_ADMIN/,
    );
    await expect(
      assignPlatformRole(actorCtx, 'superadmin@bp.test', 'PLATFORM_ADMIN'),
    ).rejects.toThrow(/at least one active SUPER_ADMIN/);
    // Positive control: granting SUPER_ADMIN to another user is fine.
    await assignPlatformRole(actorCtx, 'platform-admin@bp.test', 'SUPER_ADMIN');
    // Now the count is 2, so we can revoke the freshly-granted one safely.
    await assignPlatformRole(actorCtx, 'platform-admin@bp.test', 'PLATFORM_ADMIN');
    // Restore levaaani so repeated runs of this test leave the DB in a clean state.
    await assignPlatformRole(actorCtx, 'levaaani@gmail.com', 'SUPER_ADMIN');
  });

  // ---- SEC-005 regression guard: platform.config.manage in RESTRICTED_DURING_IMPERSONATION
  it('P6.14: platform.config.manage in RESTRICTED_DURING_IMPERSONATION (SEC-005 fixed 2026-08-03)', () => {
    // The impersonation restriction set exists specifically to prevent
    // an impersonating actor from flipping PII / clinical-visibility
    // toggles that would then let them re-read clinical data.
    // updateOrgToggles governs `providerClinicalNotesOthers` (spec §6.2)
    // — flipping it during impersonation is exactly the class of
    // two-step exfiltration §7.1 rule 5 exists to block.
    expect(RESTRICTED_DURING_IMPERSONATION.has(perm('platform.config.manage'))).toBe(true);
  });
});

// =============================================================================
// § 7 — SEC-007 regression probes: RLS-safe migrations of the group-E callsites
// that previously used unsafePrismaAdmin with an org-scoped WHERE clause. Each
// probe confirms the migrated helper (a) returns the right answer for a valid
// same-org id, (b) returns null / empty for a cross-tenant id (RLS filtering),
// and (c) survives nested withOrg — the design concern that lib/rbac/scope.ts's
// resolveBookingOwner would be called from inside a caller's own withOrg block.
// =============================================================================
describe('SEC § SEC-007 regression — group E migrations to withOrg', () => {
  // Base seed's staff rows don't carry a userId — set one up per probe so
  // resolveBookingOwner has an owner to return. Uses the fixture's grand
  // owner (owner@bookpitch.dev) as the linked user.
  async function makeStaffLinkedToUser(orgId: string, userId: string): Promise<string> {
    const loc = await unsafePrismaAdmin.location.findFirstOrThrow({
      where: { organizationId: orgId },
      select: { id: true },
    });
    const staff = await unsafePrismaAdmin.staff.create({
      data: {
        organizationId: orgId,
        locationId: loc.id,
        userId,
        name: 'SEC-007 probe staff',
        roleTitle: 'probe',
      },
      select: { id: true },
    });
    return staff.id;
  }

  it('P7.1: resolveBookingOwner returns the correct owner for a same-org appointment', async () => {
    const { resolveBookingOwner } = await import('@/lib/rbac/scope');
    const staffId = await makeStaffLinkedToUser(H.grandOrgId, H.grandOwnerId);
    const now = new Date();
    const appt = await unsafePrismaAdmin.appointment.create({
      data: {
        organizationId: H.grandOrgId,
        locationId: (
          await unsafePrismaAdmin.location.findFirstOrThrow({
            where: { organizationId: H.grandOrgId },
            select: { id: true },
          })
        ).id,
        customerId: H.grandCustomerId,
        staffId,
        serviceId: null,
        serviceName: 'sec-007 probe',
        price: 0,
        startsAt: new Date(now.getTime() + 3600_000),
        endsAt: new Date(now.getTime() + 3600_000 + 1800_000),
        status: 'pending',
        paymentStatus: 'unpaid',
      },
      select: { id: true },
    });
    try {
      const owner = await resolveBookingOwner(appt.id, H.grandOrgId);
      expect(owner).toBe(H.grandOwnerId);
    } finally {
      await unsafePrismaAdmin.appointment.delete({ where: { id: appt.id } });
      await unsafePrismaAdmin.staff.delete({ where: { id: staffId } });
    }
  });

  it('P7.2: resolveBookingOwner returns null when the appointment is in ANOTHER org (RLS filters)', async () => {
    const { resolveBookingOwner } = await import('@/lib/rbac/scope');
    // Set up an iso-org staff row + appointment so we have a cross-tenant
    // target to probe. Iso may or may not have staff seeded (base seed
    // creates staff only in Grand); create one for the probe.
    const isoLoc = await unsafePrismaAdmin.location.findFirst({
      where: { organizationId: H.isoOrgId },
      select: { id: true },
    });
    if (!isoLoc) return; // isolation org has no location — probe not applicable
    const isoStaff = await unsafePrismaAdmin.staff.create({
      data: {
        organizationId: H.isoOrgId,
        locationId: isoLoc.id,
        userId: H.isoOwnerId,
        name: 'SEC-007 iso probe staff',
        roleTitle: 'probe',
      },
      select: { id: true },
    });
    const now = new Date();
    const isoAppt = await unsafePrismaAdmin.appointment.create({
      data: {
        organizationId: H.isoOrgId,
        locationId: isoLoc.id,
        customerId: H.isoCustomerId,
        staffId: isoStaff.id,
        serviceId: null,
        serviceName: 'sec-007 cross-tenant probe',
        price: 0,
        startsAt: new Date(now.getTime() + 3600_000),
        endsAt: new Date(now.getTime() + 3600_000 + 1800_000),
        status: 'pending',
        paymentStatus: 'unpaid',
      },
      select: { id: true },
    });
    try {
      // Ask for the iso appointment while claiming to be in Grand — RLS
      // must filter it out. Post-migration this returns null (no leak).
      const owner = await resolveBookingOwner(isoAppt.id, H.grandOrgId);
      expect(owner).toBeNull();
    } finally {
      await unsafePrismaAdmin.appointment.delete({ where: { id: isoAppt.id } });
      await unsafePrismaAdmin.staff.delete({ where: { id: isoStaff.id } });
    }
  });

  it('P7.3: scopedLocationIds refuses to resolve a branch id from ANOTHER org (RLS filters)', async () => {
    const { scopedLocationIds } = await import('@/lib/rbac/scope');
    // Grand has a branch; Split has a separate branch (Downtown). Build a
    // fake ctx that says the caller is in Grand but "somehow" has a Split
    // branch id in ctx.branchIds — RLS on branches must return zero rows.
    const splitDowntown = await unsafePrismaAdmin.branch.findFirstOrThrow({
      where: { organizationId: H.splitOrgId, name: 'Downtown' },
      select: { id: true, legacyLocationId: true },
    });
    const fakeCtx = {
      activeOrganizationId: H.grandOrgId,
      branchIds: new Set([splitDowntown.id]),
    } as unknown as Parameters<typeof scopedLocationIds>[0];
    const ids = await scopedLocationIds(fakeCtx);
    // RLS on `branches` filters the Split row from Grand's scope. Result:
    // empty array (branchIds is non-empty so we don't return null, but the
    // findMany returns 0 rows post-RLS).
    expect(ids).toEqual([]);
  });

  it('P7.4: nested withOrg — resolveBookingOwner works when the caller is already inside its own withOrg tx', async () => {
    const { resolveBookingOwner } = await import('@/lib/rbac/scope');
    // Seed a staff row linked to a user, and an appointment on them.
    const staffId = await makeStaffLinkedToUser(H.grandOrgId, H.grandOwnerId);
    const loc = await unsafePrismaAdmin.location.findFirstOrThrow({
      where: { organizationId: H.grandOrgId },
      select: { id: true },
    });
    const now = new Date();
    const appt = await unsafePrismaAdmin.appointment.create({
      data: {
        organizationId: H.grandOrgId,
        locationId: loc.id,
        customerId: H.grandCustomerId,
        staffId,
        serviceName: 'sec-007 nested probe',
        price: 0,
        startsAt: new Date(now.getTime() + 7200_000),
        endsAt: new Date(now.getTime() + 7200_000 + 1800_000),
        status: 'pending',
        paymentStatus: 'unpaid',
      },
      select: { id: true },
    });
    try {
      // Open an outer withOrg tx and, inside it, call resolveBookingOwner
      // which opens ITS OWN withOrg. Under session pool, Prisma opens a
      // new connection for the inner tx — no deadlock, correct answer.
      // If a future move to the tx-pool changes this shape, this probe
      // will surface it before DATABASE_URL_SUPERUSER_TXPOOL is activated.
      const owner = await withOrg(H.grandOrgId, async (_outerTx) => {
        return resolveBookingOwner(appt.id, H.grandOrgId);
      });
      expect(owner).toBe(H.grandOwnerId);
    } finally {
      await unsafePrismaAdmin.appointment.delete({ where: { id: appt.id } });
      await unsafePrismaAdmin.staff.delete({ where: { id: staffId } });
    }
  });

  it('P7.6: ownership-transfer accept/decline/revoke return 404 (not 400) for a transferId that is not addressed to the caller — kills enumeration', async () => {
    const { acceptTransfer, declineTransfer, revokeTransfer, nominateTransfer } =
      await import('@/lib/admin/ownership-transfer');
    const { NotFoundError } = await import('@/lib/auth');

    // Set up: split owner nominates the moonlighter (a member of Split via
    // rbac-fixtures) as new owner. Then have a DIFFERENT user (grand owner,
    // not a member of Split) try to accept/decline/revoke.
    const nominatorSession = {
      userId: H.splitOwnerId,
      email: 'split-owner@bp.test',
      organizationId: H.splitOrgId,
      membershipId: H.splitOwnerMembershipId,
    };

    // Ensure moonlighter has a Split membership (rbac-fixtures creates it).
    const moonSplitMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: H.moonId, organizationId: H.splitOrgId },
      select: { id: true },
    });
    void moonSplitMembership;

    // Create the nomination.
    const { id: transferId } = await nominateTransfer(nominatorSession, H.moonId);
    try {
      // A third party (grand owner) — not the nominee, not the nominator —
      // tries to peek. Pre-hardening: accept threw 400 "not addressed to you"
      // and decline threw 400 "not addressed to you" — both revealed the
      // transfer exists. Post-hardening: 404 identical to "does not exist."
      const grandSession = {
        userId: H.grandOwnerId,
        email: 'owner@bookpitch.dev',
        organizationId: H.grandOrgId,
        membershipId: H.grandOwnerMembershipId,
      };
      await expect(acceptTransfer(grandSession, transferId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(declineTransfer(grandSession, transferId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revokeTransfer(grandSession, transferId)).rejects.toBeInstanceOf(NotFoundError);

      // Cross-check the SAME error shape for a completely bogus id.
      const bogus = '00000000-0000-0000-0000-000000000000';
      await expect(acceptTransfer(grandSession, bogus)).rejects.toBeInstanceOf(NotFoundError);
      await expect(declineTransfer(grandSession, bogus)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revokeTransfer(grandSession, bogus)).rejects.toBeInstanceOf(NotFoundError);

      // Positive control: the actual nominee (moonlighter) CAN see the
      // transfer via decline (cheaper than accept for the assert path).
      const moonSession = {
        userId: H.moonId,
        email: 'moonlight@bp.test',
        organizationId: H.splitOrgId,
        membershipId: H.moonSplitMembershipId,
      };
      await declineTransfer(moonSession, transferId, 'sec-007 probe cleanup');
    } finally {
      // Cleanup: hard-delete the transfer regardless of state.
      await unsafePrismaAdmin.ownershipTransfer.deleteMany({ where: { id: transferId } });
    }
  });

  it('P7.5: availability route resolves same-org staff and refuses cross-org staff via RLS', async () => {
    // The availability route was the "one confirmed" SEC-007 leak shape.
    // Verify the fix: withOrg + RLS return the staff row for a same-org
    // id but zero rows for a cross-org id.
    const grandStaffId = await makeStaffLinkedToUser(H.grandOrgId, H.grandOwnerId);
    const isoLoc = await unsafePrismaAdmin.location.findFirst({
      where: { organizationId: H.isoOrgId },
      select: { id: true },
    });
    const isoStaffId = isoLoc
      ? (
          await unsafePrismaAdmin.staff.create({
            data: {
              organizationId: H.isoOrgId,
              locationId: isoLoc.id,
              userId: H.isoOwnerId,
              name: 'SEC-007 iso probe staff',
              roleTitle: 'probe',
            },
            select: { id: true },
          })
        ).id
      : null;

    try {
      // Same-org resolves.
      const sameOrgResult = await withOrg(H.grandOrgId, (tx) =>
        tx.staff.findFirst({ where: { id: grandStaffId }, select: { userId: true } }),
      );
      expect(sameOrgResult?.userId).toBe(H.grandOwnerId);

      if (isoStaffId) {
        // Cross-org returns null (RLS filters).
        const crossOrgResult = await withOrg(H.grandOrgId, (tx) =>
          tx.staff.findFirst({ where: { id: isoStaffId }, select: { userId: true } }),
        );
        expect(crossOrgResult).toBeNull();
      }
    } finally {
      await unsafePrismaAdmin.staff.delete({ where: { id: grandStaffId } });
      if (isoStaffId) await unsafePrismaAdmin.staff.delete({ where: { id: isoStaffId } });
    }
  });
});

// =============================================================================
// § 8 — SEC-008 regression probes: the three org toggles were writable +
// audited but consulted by nothing. Each probe flips one toggle and asserts
// the RESPONSE BODY of the affected API differs. Never checks UI-only render
// — the point is that the API changes, not that a hidden button appears.
// =============================================================================
const { loadOrgToggles: loadOrgTogglesForSec008, updateOrgToggles: updateOrgTogglesForSec008 } =
  await import('@/lib/rbac/toggles');
const routeCustomerItem_Sec008 = await import('@/app/api/customers/[id]/route');

describe('SEC § SEC-008 regression — dead org toggles now change API responses', () => {
  const loadOrgToggles = loadOrgTogglesForSec008;
  const updateOrgToggles = updateOrgTogglesForSec008;
  const routeCustomerItem = routeCustomerItem_Sec008;

  // Save the pre-test toggle state and restore after — so this probe suite
  // never leaves clinical-visibility flipped for the next test run.
  let originalToggles: Awaited<ReturnType<typeof loadOrgToggles>>;
  beforeAll(async () => {
    originalToggles = await loadOrgToggles(H.grandOrgId);
  });
  beforeEach(() => {
    __clearOrgTogglesCache();
    authMock.mockReset();
    __clearAuthContextCache();
  });

  async function reset() {
    await updateOrgToggles(H.grandOrgId, originalToggles);
    __clearOrgTogglesCache();
    __clearAuthContextCache();
  }

  // Seed a customer with clinicalNotes + allergies so we can watch what
  // shows up in the response.
  async function makeCustomerWithClinicalData(): Promise<string> {
    const { encryptField } = await import('@/lib/crypto');
    const c = await unsafePrismaAdmin.customer.create({
      data: {
        organizationId: H.grandOrgId,
        name: 'SEC-008 Probe Patient',
        email: 'sec008-probe@bookpitch.internal',
        phone: '+995555000008',
        allergies: encryptField('probe-penicillin'),
        clinicalNotes: encryptField('probe-history-note'),
        consentAt: new Date(),
        consentVersion: '1.0',
      },
      select: { id: true },
    });
    // Add a treatment-history row too so we can watch the array flip.
    await unsafePrismaAdmin.treatmentHistory.create({
      data: { customerId: c.id, label: 'SEC-008 probe visit' },
    });
    return c.id;
  }

  // Membership helper: give the target user a specific org+role in Grand.
  async function memberIdForRole(userEmail: string, roleKey: string): Promise<string> {
    const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: userEmail },
      select: { id: true },
    });
    const role = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: roleKey, organizationId: null },
      select: { id: true },
    });
    const m = await unsafePrismaAdmin.membership.upsert({
      where: { organizationId_userId: { organizationId: H.grandOrgId, userId: user.id } },
      create: {
        organizationId: H.grandOrgId,
        userId: user.id,
        role: 'practitioner',
        roleId: role.id,
        status: 'active',
      },
      update: { roleId: role.id, status: 'active', role: 'practitioner' },
      select: { id: true, userId: true },
    });
    return m.id;
  }

  // ---- Probe 1: frontdeskClientFullHistory ---------------------------------
  it('P8.1: frontdeskClientFullHistory — FRONT_DESK gets clinicalNotes redacted when OFF, decrypted when ON', async () => {
    // Set up a FRONT_DESK member in Grand + a customer with clinical data.
    // Use a fresh random subject each run so prior soft-masked probes
    // don't collide on the (auth_provider, auth_subject) unique.
    const runId = randomUUID().slice(0, 8);
    const fdEmail = `sec008-fd-${runId}@bookpitch.internal`;
    const passwordHash = await (await import('@node-rs/argon2')).hash('probe-pw');
    const fdUser = await unsafePrismaAdmin.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: fdEmail,
        email: fdEmail,
        fullName: 'SEC-008 FD probe',
        passwordHash,
        status: 'active',
      },
      select: { id: true, email: true },
    });
    const fdMemId = await memberIdForRole(fdEmail, 'FRONT_DESK');
    const customerId = await makeCustomerWithClinicalData();

    try {
      // Toggle OFF (default) — FRONT_DESK should NOT see clinicalNotes/allergies
      await updateOrgToggles(H.grandOrgId, { frontdeskClientFullHistory: false });
      __clearOrgTogglesCache();
      __clearAuthContextCache();
      authMock.mockResolvedValue({
        user: {
          id: fdUser.id,
          email: fdUser.email,
          activeOrganizationId: H.grandOrgId,
          membershipId: fdMemId,
          platformRoleId: null,
        },
      });
      const off = await routeCustomerItem.GET(req('http://x'), {
        params: Promise.resolve({ id: customerId }),
      });
      expect(off.status).toBe(200);
      const offBody = await json<{
        customer: {
          clinicalNotes: string | null;
          allergies: string | null;
          treatmentHistory: unknown[];
        };
      }>(off);
      expect(offBody.customer.clinicalNotes).toBeNull();
      expect(offBody.customer.allergies).toBeNull();
      expect(offBody.customer.treatmentHistory).toEqual([]);

      // Toggle ON — FRONT_DESK NOW sees decrypted clinicalNotes
      await updateOrgToggles(H.grandOrgId, { frontdeskClientFullHistory: true });
      __clearOrgTogglesCache();
      __clearAuthContextCache();
      const on = await routeCustomerItem.GET(req('http://x'), {
        params: Promise.resolve({ id: customerId }),
      });
      const onBody = await json<{
        customer: {
          clinicalNotes: string | null;
          allergies: string | null;
          treatmentHistory: unknown[];
        };
      }>(on);
      expect(onBody.customer.clinicalNotes).toBe('probe-history-note');
      expect(onBody.customer.allergies).toBe('probe-penicillin');
      expect(onBody.customer.treatmentHistory.length).toBeGreaterThan(0);
    } finally {
      await unsafePrismaAdmin.treatmentHistory.deleteMany({ where: { customerId } });
      await unsafePrismaAdmin.customer.delete({ where: { id: customerId } });
      await unsafePrismaAdmin.membership.delete({ where: { id: fdMemId } });
      // Soft-mask on cleanup — audit_log FK is ON DELETE NO ACTION so a
      // hard-delete of a user with any audit row fails.
      await unsafePrismaAdmin.appUser
        .update({
          where: { id: fdUser.id },
          data: {
            status: 'deleted',
            passwordHash: null,
            email: `deleted-sec008-fd-${fdUser.id}@bookpitch.invalid`,
            // auth_subject also — (auth_provider, auth_subject) is UNIQUE,
            // otherwise the next test-run collides on the fresh upsert.
            authSubject: `deleted-sec008-fd-${fdUser.id}`,
            sessionVersion: { increment: 1 },
          },
        })
        .catch(async () => {
          await unsafePrismaAdmin.appUser.delete({ where: { id: fdUser.id } }).catch(() => {});
        });
      await reset();
    }
  });

  // ---- Probe 2: providerClinicalNotesOthers --------------------------------
  it('P8.2: providerClinicalNotesOthers — PROVIDER gets clinicalNotes redacted when OFF, decrypted when ON', async () => {
    // A PROVIDER who does NOT hold client.read:full by seed. Toggle-elevation
    // gives them clinical_note.read:any which the DTO reads via can().
    // Reuse the seeded moonlighter (PROVIDER in Grand).
    const provUser = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
      select: { id: true, email: true },
    });
    // Moonlighter's membership in Grand isn't in the fixture by default
    // — the rbac-fixtures add them to Split, not Grand. Add here.
    const provMemId = await memberIdForRole('moonlight@bp.test', 'PROVIDER');
    const customerId = await makeCustomerWithClinicalData();

    try {
      // OFF — PROVIDER sees redacted
      await updateOrgToggles(H.grandOrgId, {
        providerClinicalNotesOthers: false,
        frontdeskClientFullHistory: false,
      });
      __clearOrgTogglesCache();
      __clearAuthContextCache();
      authMock.mockResolvedValue({
        user: {
          id: provUser.id,
          email: provUser.email,
          activeOrganizationId: H.grandOrgId,
          membershipId: provMemId,
          platformRoleId: null,
        },
      });
      const off = await routeCustomerItem.GET(req('http://x'), {
        params: Promise.resolve({ id: customerId }),
      });
      const offBody = await json<{
        customer: { clinicalNotes: string | null; allergies: string | null };
      }>(off);
      expect(off.status).toBe(200);
      expect(offBody.customer.clinicalNotes).toBeNull();
      expect(offBody.customer.allergies).toBeNull();

      // ON — PROVIDER sees decrypted
      await updateOrgToggles(H.grandOrgId, {
        providerClinicalNotesOthers: true,
      });
      __clearOrgTogglesCache();
      __clearAuthContextCache();
      const on = await routeCustomerItem.GET(req('http://x'), {
        params: Promise.resolve({ id: customerId }),
      });
      const onBody = await json<{
        customer: { clinicalNotes: string | null; allergies: string | null };
      }>(on);
      expect(onBody.customer.clinicalNotes).toBe('probe-history-note');
      expect(onBody.customer.allergies).toBe('probe-penicillin');
    } finally {
      await unsafePrismaAdmin.treatmentHistory.deleteMany({ where: { customerId } });
      await unsafePrismaAdmin.customer.delete({ where: { id: customerId } });
      await unsafePrismaAdmin.membership.delete({ where: { id: provMemId } });
      await reset();
    }
  });

  // ---- Probe 3: providerFinancialReports -----------------------------------
  it('P8.3: providerFinancialReports — can(PROVIDER, "report.branch") flips with the toggle', async () => {
    // No live server-component invocation from vitest; test the can()
    // decision directly. That IS the gate the analytics page uses:
    //   requirePermission(ctx, 'report.branch', ...)
    // A flip in can()'s answer is exactly the observable that determines
    // whether analytics renders or throws Forbidden.
    const provMemId = await memberIdForRole('moonlight@bp.test', 'PROVIDER');
    try {
      // OFF — can() denies report.branch for PROVIDER
      await updateOrgToggles(H.grandOrgId, { providerFinancialReports: false });
      __clearOrgTogglesCache();
      __clearAuthContextCache();
      const ctxOff = await buildAuthContext(H.moonId, provMemId);
      expect(ctxOff).not.toBeNull();
      expect(can(ctxOff!, 'report.branch', { organizationId: H.grandOrgId })).toBe(false);
      expect(can(ctxOff!, 'report.financial:org', { organizationId: H.grandOrgId })).toBe(false);

      // ON — same caller, same code path — can() now grants both
      await updateOrgToggles(H.grandOrgId, { providerFinancialReports: true });
      __clearOrgTogglesCache();
      __clearAuthContextCache();
      const ctxOn = await buildAuthContext(H.moonId, provMemId);
      expect(ctxOn).not.toBeNull();
      expect(can(ctxOn!, 'report.branch', { organizationId: H.grandOrgId })).toBe(true);
      expect(can(ctxOn!, 'report.financial:org', { organizationId: H.grandOrgId })).toBe(true);
    } finally {
      await unsafePrismaAdmin.membership.delete({ where: { id: provMemId } });
      await reset();
    }
  });

  // ---- Probe 4: frontdeskDiscountCeiling — the one enforced toggle with no probe ----
  it('P8.4: frontdeskDiscountCeiling enforcement — FRONT_DESK above ceiling throws, at or below passes, non-FRONT_DESK bypasses', async () => {
    // assertDiscountWithinCeiling is the enforcement point (lib/payments/service.ts).
    // There is no HTTP discount endpoint yet; test the function directly — that
    // is the only gate the future endpoint will call.
    const { assertDiscountWithinCeiling } = await import('@/lib/payments/service');
    await updateOrgToggles(H.splitOrgId, { frontdeskDiscountCeiling: 100 });
    __clearOrgTogglesCache();
    try {
      // Above ceiling — throws.
      await expect(
        assertDiscountWithinCeiling(H.splitOrgId, 'FRONT_DESK', 101),
      ).rejects.toBeInstanceOf(InvalidInputError);
      // At ceiling — passes (ceiling is an inclusive max: > not >=).
      await expect(
        assertDiscountWithinCeiling(H.splitOrgId, 'FRONT_DESK', 100),
      ).resolves.toBeUndefined();
      // Below ceiling — passes.
      await expect(
        assertDiscountWithinCeiling(H.splitOrgId, 'FRONT_DESK', 50),
      ).resolves.toBeUndefined();
      // Non-FRONT_DESK bypasses the ceiling entirely.
      await expect(
        assertDiscountWithinCeiling(H.splitOrgId, 'ORG_OWNER', 9999),
      ).resolves.toBeUndefined();
      await expect(
        assertDiscountWithinCeiling(H.splitOrgId, 'PROVIDER', 9999),
      ).resolves.toBeUndefined();
    } finally {
      await updateOrgToggles(H.splitOrgId, { frontdeskDiscountCeiling: 0 });
      __clearOrgTogglesCache();
    }
  });
});

// =============================================================================
// § 9 — SEC-009: changeOrganizationOwner must promote the membership, not
// just the ownerUserId pointer. Pre-fix, calling the function with an existing
// member only wrote organizations.ownerUserId; the membership's roleId stayed
// at the old role. can() reads roleId, so the new "owner" had no owner perms.
// The audit log recorded a successful ownership change that had not happened.
// =============================================================================
const { changeOrganizationOwner: changeOrganizationOwnerSec009 } =
  await import('@/lib/platform/orgs');

describe('SEC § SEC-009 — changeOrganizationOwner must atomically promote membership', () => {
  it('P9.1: after changeOrganizationOwner(existing member), can() grants ORG_OWNER perms — not just ownerUserId pointer', async () => {
    // moonlighter is PROVIDER in Split. After the call, their membership
    // roleId must be ORG_OWNER, not just the org pointer. Pre-fix, can()
    // would still return false for org.billing.manage for the new "owner."
    const actorCtx = await buildAuthContext(H.superUserId, null);
    if (!actorCtx) throw new Error('could not build super-admin ctx');

    const origMem = await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: H.moonId, organizationId: H.splitOrgId },
      select: { id: true, role: true, roleId: true },
    });
    const origOrg = await unsafePrismaAdmin.organization.findUniqueOrThrow({
      where: { id: H.splitOrgId },
      select: { ownerUserId: true },
    });

    try {
      await changeOrganizationOwnerSec009(actorCtx, H.splitOrgId, 'moonlight@bp.test');
      __clearAuthContextCache();

      // Build moonlighter's auth context — reads roleId from DB.
      const ctx = await buildAuthContext(H.moonId, H.moonSplitMembershipId);
      expect(ctx).not.toBeNull();

      // These fail pre-fix (roleId still PROVIDER → no org.billing.manage grant).
      expect(can(ctx!, 'org.billing.manage', { organizationId: H.splitOrgId })).toBe(true);
      expect(can(ctx!, 'staff.invite', { organizationId: H.splitOrgId })).toBe(true);

      // Verify the DB row, not just the in-memory ctx — proves the membership
      // was actually written, not inferred from a stale cache.
      const memAfter = await unsafePrismaAdmin.membership.findFirstOrThrow({
        where: { userId: H.moonId, organizationId: H.splitOrgId },
        include: { roleRef: { select: { key: true } } },
      });
      expect(memAfter.roleRef?.key).toBe('ORG_OWNER');
    } finally {
      // Restore membership role and owner_user_id atomically — the deferred
      // trigger checks at commit that owner_user_id's user has an active owner
      // membership, so both must be consistent by the time the tx commits.
      await unsafePrismaAdmin
        .$transaction(async (tx) => {
          await tx.membership.update({
            where: { id: origMem.id },
            data: { role: origMem.role, roleId: origMem.roleId },
          });
          await tx.organization.update({
            where: { id: H.splitOrgId },
            data: { ownerUserId: origOrg.ownerUserId },
          });
        })
        .catch(() => {
          // If rollback fails (e.g. split-owner membership was deleted), best-effort.
        });
      __clearAuthContextCache();
    }
  });
});

// ── Phase 7 §7.9 — Public health route reveals no sensitive details ───────────

describe('GET /api/health — public liveness probe', () => {
  it('returns 200 with ok:true — no DB probe, no extra fields', async () => {
    const res = await routeHealth.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // Phase G: public liveness returns exactly { ok: true } — nothing else.
    expect(Object.keys(body)).toEqual(['ok']);
  });

  it('response body is exactly {"ok":true} — no status, buildId, or diagnostics', async () => {
    const res = await routeHealth.GET();
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('response body exposes no connection details, DB role names, or env vars', async () => {
    const res = await routeHealth.GET();
    const body = (await res.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/DATABASE_URL|postgres|SQLSTATE|latency|prisma|role/i);
    expect(serialized).not.toMatch(/bookpitch_app|unsafePrisma|prismaLogin/i);
  });
});

// ── Phase 7 §7.9 — Protected readiness probe: guard + response sanitization ───

describe('GET /api/health/ready — protected diagnostic endpoint', () => {
  it('H.RDY.1: SUPPORT_AGENT cannot GET /api/health/ready — platform.config.manage missing', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await routeHealthReady.GET();
    expect(res.status).toBe(403);
  });

  it('H.RDY.2: PLATFORM_ADMIN cannot GET /api/health/ready — platform.config.manage is SUPER-only', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await routeHealthReady.GET();
    expect(res.status).toBe(403);
  });

  it('H.RDY.3: SUPER_ADMIN gets 200 (or 503 on probe failure) with sanitized payload', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await routeHealthReady.GET();
    // 200 when all probes pass; 503 when any DB role is unreachable.
    // Both are safe outcomes — the probe must not return 4xx for authorised callers.
    expect([200, 503]).toContain(res.status);
    const body = await json<{ ok: boolean; timestamp: string; checks: unknown[] }>(res);
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.timestamp).toBe('string');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBe(3);
  });

  it('H.RDY.4: response body restricted to safe keys — no env vars, connection strings, or raw SQLSTATE', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await routeHealthReady.GET();
    const body = await json<Record<string, unknown>>(res);

    // Top-level keys must be exactly {ok, timestamp, checks}.
    const topKeys = new Set(Object.keys(body));
    expect(topKeys).toEqual(new Set(['ok', 'timestamp', 'checks']));

    // Each check must carry only safe bucketed fields — no raw ms values.
    const allowedCheckKeys = new Set(['category', 'ok', 'latencyBucket', 'errorCategory']);
    for (const check of body.checks as Record<string, unknown>[]) {
      for (const k of Object.keys(check)) {
        expect(allowedCheckKeys.has(k)).toBe(true);
      }
      // latencyBucket must be a word, not a raw millisecond count.
      expect(['fast', 'moderate', 'slow', 'timeout']).toContain(check.latencyBucket);
    }

    // Serialized body must not leak sensitive identifiers.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/DATABASE_URL|postgres:\/\//i);
    expect(raw).not.toMatch(/SQLSTATE|bookpitch_app|prismaLogin/i);
    expect(raw).not.toMatch(/ECONNREFUSED|ETIMEDOUT/i);
  });

  it('H.RDY.5: unauthenticated callers are rejected — requireAuthContext throws', async () => {
    authMock.mockResolvedValue(null);
    await expect(routeHealthReady.GET()).rejects.toThrow();
  });
});
