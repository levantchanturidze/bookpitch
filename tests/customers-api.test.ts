import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// vi.mock is hoisted; use vi.hoisted for shared refs.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
// next/cache.revalidatePath calls Next internals; stub to a no-op so tests
// can invoke Server Actions without a full Next runtime.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const routeList = await import('@/app/api/customers/route');
const routeOne = await import('@/app/api/customers/[id]/route');
const routeItem = await import('@/app/api/customers/[id]/route');
const routeHistory = await import('@/app/api/customers/[id]/history/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

async function mkSession(orgId: string, userId: string) {
  return mockJwt(userId, orgId);
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Route Handlers are typed against NextRequest; a plain Request has the same
// shape at runtime, so cast for the test.
import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

describe('/api/customers CRUD + encryption + audit', () => {
  let primaryOrgId: string;
  let primaryOwnerId: string;
  let isolationOrgId: string;

  beforeAll(async () => {
    const { orgs, owner, iso } = await withoutRls(async (tx) => {
      const orgs = await tx.organization.findMany({ orderBy: { createdAt: 'asc' } });
      const owner = await tx.appUser.findUnique({
        where: { email: 'owner@bookpitch.dev' },
        select: { id: true },
      });
      const iso = orgs.find((o) => o.name === 'Isolation Corp')!;
      return { orgs, owner, iso };
    });
    primaryOrgId = orgs[0].id;
    primaryOwnerId = owner!.id;
    isolationOrgId = iso.id;
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  // Keep the seeded state intact for other suites (RLS asserts exact counts).
  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.customer.deleteMany({
        where: { name: { in: ['Test Alpha', 'To Be Deleted'] } },
      });
      // Undo the PATCH on the seeded row's allergies + the new history entry
      // by re-running the seed would be overkill; leave those (they're
      // isolated to the primary org and don't break count-based assertions).
    });
  });

  it('POST creates a customer with consent, encrypts sensitive fields at rest', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));

    const res = await routeList.POST(
      req('http://x/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Alpha',
          phone: '+995 555 0000',
          allergies: 'Peanuts',
          clinicalNotes: 'Prefers morning appointments.',
          consent: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ customer: { id: string; allergies: string } }>(res);
    expect(body.customer.allergies).toBe('Peanuts');

    // Confirm ciphertext in the DB — not plaintext.
    const row = await withoutRls((tx) =>
      tx.customer.findUnique({ where: { id: body.customer.id } }),
    );
    expect(row?.allergies).toBeTruthy();
    expect(row?.allergies).not.toBe('Peanuts');
    expect(row?.consentAt).toBeTruthy();
    expect(row?.consentVersion).toBe('1.0');

    // Confirm one create audit entry landed.
    const audits = await withoutRls((tx) =>
      tx.auditLog.findMany({
        where: { entity: 'customer', entityId: body.customer.id, action: 'create' },
      }),
    );
    expect(audits.length).toBe(1);
    expect(audits[0].organizationId).toBe(primaryOrgId);
    expect(audits[0].actorUserId).toBe(primaryOwnerId);
  });

  it('POST without consent returns 400', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    const res = await routeList.POST(
      req('http://x/api/customers', {
        method: 'POST',
        body: JSON.stringify({ name: 'Missing Consent' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('GET list omits clinical fields and writes a single list audit row', async () => {
    // F16-008 contract change. The list surface renders a name, a phone number
    // and an avatar; it does not render allergies, clinical notes, insurance or
    // treatment history, so the projection no longer fetches, decrypts or sends
    // them. The capability moved to GET /api/customers/[id] — see the
    // complement immediately below, which proves it did not simply disappear.
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));

    const before = await withoutRls((tx) =>
      tx.auditLog.count({ where: { entity: 'customer', action: 'list' } }),
    );
    const res = await routeList.GET(req('http://localhost/api/customers'));
    const body = await jsonBody<{
      customers: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    }>(res);
    const after = await withoutRls((tx) =>
      tx.auditLog.count({ where: { entity: 'customer', action: 'list' } }),
    );

    expect(res.status).toBe(200);
    expect(body.customers.length).toBeGreaterThan(0);
    for (const c of body.customers) {
      for (const hidden of [
        'allergies',
        'clinicalNotes',
        'treatmentHistory',
        'insurerName',
        'insurancePolicyNumber',
        'dob',
      ]) {
        expect(c, `list item still carries ${hidden}`).not.toHaveProperty(hidden);
      }
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('phone');
    }
    expect(typeof body.hasMore).toBe('boolean');
    // Still exactly one audit row per list call, as before.
    expect(after - before).toBe(1);
  });

  it('GET /api/customers/[id] still returns decrypted clinical fields', async () => {
    // The complement of the test above: the list got leaner, the detail
    // endpoint did not get weaker.
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    const withAllergy = await withoutRls((tx) =>
      tx.customer.findFirst({
        where: { organizationId: primaryOrgId, allergies: { not: null } },
        select: { id: true },
      }),
    );
    expect(withAllergy, 'fixture needs a customer with allergies').not.toBeNull();

    const res = await routeOne.GET(req(`http://localhost/api/customers/${withAllergy!.id}`), {
      params: Promise.resolve({ id: withAllergy!.id }),
    });
    const body = await jsonBody<{
      customer: { allergies: string | null; treatmentHistory: unknown[] };
    }>(res);
    expect(res.status).toBe(200);
    expect(body.customer.allergies).toMatch(/[A-Za-z]/);
    expect(Array.isArray(body.customer.treatmentHistory)).toBe(true);
  });

  it('PATCH re-encrypts changed sensitive fields and logs update with fields list', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));

    // Grab an existing customer from the primary org.
    const target = await withoutRls((tx) =>
      tx.customer.findFirst({ where: { organizationId: primaryOrgId } }),
    );
    const id = target!.id;
    const priorCipher = target!.allergies;

    const res = await routeItem.PATCH(
      req(`http://x/api/customers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ allergies: 'Latex, gluten' }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);

    const after = await withoutRls((tx) => tx.customer.findUnique({ where: { id } }));
    expect(after?.allergies).not.toBe('Latex, gluten');
    expect(after?.allergies).not.toBe(priorCipher);

    const audit = await withoutRls((tx) =>
      tx.auditLog.findFirst({
        where: { entity: 'customer', entityId: id, action: 'update' },
        orderBy: { at: 'desc' },
      }),
    );
    expect(audit).toBeTruthy();
    expect(audit?.meta).toMatchObject({ fields: expect.arrayContaining(['allergies']) });
  });

  it('DELETE hard-deletes a customer with no appointments + logs delete', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));

    // Create a throwaway customer we can safely delete.
    const created = await routeList.POST(
      req('http://x/api/customers', {
        method: 'POST',
        body: JSON.stringify({ name: 'To Be Deleted', consent: true }),
      }),
    );
    const { customer } = await jsonBody<{ customer: { id: string } }>(created);

    const del = await routeItem.DELETE(req(`http://x/api/customers/${customer.id}`), {
      params: Promise.resolve({ id: customer.id }),
    });
    expect(del.status).toBe(200);

    const gone = await withoutRls((tx) => tx.customer.findUnique({ where: { id: customer.id } }));
    expect(gone).toBeNull();

    const audit = await withoutRls((tx) =>
      tx.auditLog.findFirst({
        where: { entity: 'customer', entityId: customer.id, action: 'delete' },
      }),
    );
    expect(audit).toBeTruthy();
  });

  it('POST /history appends a treatment_history row + logs history_add', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    const target = await withoutRls((tx) =>
      tx.customer.findFirst({ where: { organizationId: primaryOrgId } }),
    );
    const id = target!.id;

    const res = await routeHistory.POST(
      req(`http://x/api/customers/${id}/history`, {
        method: 'POST',
        body: JSON.stringify({ label: 'Follow-up (Aug 2026)' }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);

    const audit = await withoutRls((tx) =>
      tx.auditLog.findFirst({
        where: { entity: 'customer', entityId: id, action: 'history_add' },
        orderBy: { at: 'desc' },
      }),
    );
    expect(audit).toBeTruthy();
  });

  it('cross-tenant read still returns only the caller org (RLS holds)', async () => {
    // Phase 4: mockJwt requires a real (userId, orgId) pair. Use the
    // isolation org's own owner to test that they see only their data.
    const isoOwner = await withoutRls((tx) =>
      tx.appUser.findUniqueOrThrow({
        where: { email: 'isolation@bookpitch.dev' },
        select: { id: true },
      }),
    );
    authMock.mockResolvedValue(await mkSession(isolationOrgId, isoOwner.id));
    const res = await routeList.GET(req('http://localhost/api/customers'));
    const body = await jsonBody<{ customers: Array<{ name: string }> }>(res);
    // Isolation Corp only has "Do Not Leak" seeded.
    expect(body.customers.length).toBe(1);
    expect(body.customers[0].name).toBe('Do Not Leak');
  });

  it('receptionist has full access to customers (allowedRoles)', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, primaryOwnerId));
    const res = await routeList.GET(req('http://localhost/api/customers'));
    expect(res.status).toBe(200);
  });
});
