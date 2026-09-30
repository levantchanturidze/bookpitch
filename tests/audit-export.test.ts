import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// GET /api/audit/export must answer with the CSV it builds.
//
// Found in production UAT on 2026-09-30: the "Export CSV" button on /audit
// downloaded the two bytes `{}`. The route built its CSV correctly and then
// returned it through withApi(), which JSON-serialises the handler's return
// value — and JSON.stringify(new Response(csv)) is "{}". Nothing tested the
// route, only the query underneath it (tests/audit-query.test.ts), so the
// wiring looked healthy while the response meant nothing.
//
// These tests read the RESPONSE BODY, and pair the allow case with the refusal
// for a member who does not hold audit.read.
// -----------------------------------------------------------------------------

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({ auth: authMock, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const route = await import('@/app/api/audit/export/route');

const HEADER = 'timestamp,actor_email,action,entity,entity_id,customer_name,meta';
const PROBE = 'audit-export-probe';

let orgId: string;
let ownerId: string;
let deskId: string;

beforeAll(async () => {
  const ts = Date.now();
  const seed = await withoutRls(async (tx) => {
    const [ownerRole, deskRole] = await Promise.all([
      tx.role.findFirstOrThrow({ where: { key: 'ORG_OWNER', organizationId: null } }),
      tx.role.findFirstOrThrow({ where: { key: 'FRONT_DESK', organizationId: null } }),
    ]);
    const org = await tx.organization.create({ data: { name: `Audit Export ${ts}` } });
    const user = (tag: string) =>
      tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `audit-export-${tag}-${ts}@bookpitch.dev`,
          email: `audit-export-${tag}-${ts}@bookpitch.dev`,
        },
      });
    const owner = await user('owner');
    const desk = await user('desk');
    await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: ownerRole.id },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: desk.id, role: 'receptionist', roleId: deskRole.id },
    });
    await tx.auditLog.create({
      data: {
        organizationId: org.id,
        actorUserId: owner.id,
        action: 'create',
        entity: 'location',
        entityId: null,
        meta: { name: PROBE },
      },
    });
    return { orgId: org.id, ownerId: owner.id, deskId: desk.id };
  });
  ({ orgId, ownerId, deskId } = seed);
});

afterAll(async () => {
  if (!orgId) return;
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([orgId]);
  await withoutRls(async (tx) => {
    await tx.membership.deleteMany({ where: { organizationId: orgId } });
    await tx.appUser.deleteMany({ where: { id: { in: [ownerId, deskId] } } });
    await tx.organization.delete({ where: { id: orgId } });
  });
});

beforeEach(() => {
  authMock.mockReset();
  __clearAuthContextCache();
});

const get = () => route.GET(new NextRequest('http://localhost/api/audit/export'));

describe('GET /api/audit/export', () => {
  it('an owner receives the CSV itself — header, rows, text/csv, attachment — not "{}"', async () => {
    authMock.mockResolvedValue(await mockJwt(ownerId, orgId));
    const res = await get();
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toBe('{}');
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-/);

    const [header, ...rows] = body.split('\r\n');
    expect(header).toBe(HEADER);
    expect(rows.some((r) => r.includes(PROBE))).toBe(true);
  });

  it('the complement: a member without audit.read is refused and receives no CSV', async () => {
    authMock.mockResolvedValue(await mockJwt(deskId, orgId));
    const res = await get();
    const body = await res.text();

    expect(res.status).toBe(403);
    expect(body).not.toContain(HEADER);
    expect(body).not.toContain(PROBE);
  });
});
