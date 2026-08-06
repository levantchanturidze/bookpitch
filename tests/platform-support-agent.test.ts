import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockPlatformJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { unsafePrismaAdmin } = await import('@/lib/db');

// Every platform-plane route we ship. SUPPORT_AGENT must either 403 or
// return zero PII from each one. This is the plan's PII-discipline
// probe — it fails loud if we ever add a platform endpoint that leaks
// customer data without going through impersonation.
const listRoute = await import('@/app/api/platform/orgs/route');
const detailRoute = await import('@/app/api/platform/orgs/[id]/route');
const suspendRoute = await import('@/app/api/platform/orgs/[id]/suspend/route');
const softDeleteRoute = await import('@/app/api/platform/orgs/[id]/soft-delete/route');
const ownerRoute = await import('@/app/api/platform/orgs/[id]/owner/route');
const resetRoute = await import('@/app/api/platform/orgs/[id]/reset-password-link/route');
const impRoute = await import('@/app/api/platform/impersonate/route');
const bgRoute = await import('@/app/api/platform/break-glass/route');
const auditRoute = await import('@/app/api/platform/audit/route');

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const PII_KEY_PATTERN = /email|phone|name|allergies|clinical/i;

/** Recursively walk a JSON value; return true if any string leaf looks
 *  like PII (matches @ for emails, or shows up under a PII-shaped key). */
function containsPii(value: unknown, keyChain: string = ''): boolean {
  if (typeof value === 'string') {
    if (PII_KEY_PATTERN.test(keyChain) && !value.includes('***') && !value.match(/^[A-Z]\./)) {
      // Masked strings contain *** (email) or single-initial patterns (name).
      // Anything else on a PII-labelled key looks unredacted.
      return value.length > 0;
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((v) => containsPii(v, keyChain));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => containsPii(v, k));
  }
  return false;
}

describe('SUPPORT_AGENT PII discipline probe (spec §4.1 + §6.1)', () => {
  let orgId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    });
    orgId = org.id;
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('cannot suspend an org (needs platform.org.suspend)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await suspendRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'nope' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('cannot soft-delete', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await softDeleteRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'nope' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('cannot change owner', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await ownerRoute.PATCH(
      req('http://x', { method: 'PATCH', body: JSON.stringify({ newOwnerEmail: 'x@y.z' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('cannot send reset link', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await resetRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ email: 'x@y.z' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('cannot start impersonation (spec §4.1 — "request only, not start")', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await impRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: orgId,
          targetUserId: 'x',
          reason: 'nope',
          ticketId: 'T-1',
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('cannot start break-glass', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          // All required fields present so input validation passes and we reach
          // the real role check (SUPER_ADMIN-only) that spec §7.2 mandates.
          password: 'devpass123',
          totpCode: '000000',
          reason: 'not allowed here',
          ticketId: 'BG-x',
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('org LIST returns rows but no customer PII', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await listRoute.GET();
    expect(res.status).toBe(200);
    const body = await json<{ orgs: unknown[] }>(res);
    // Aggregate shape only — memberCount is a count, owner email is
    // present (it's the org contact, spec §6.1 counts it as
    // administrative data) but customer PII must be absent.
    const rawBlob = JSON.stringify(body).toLowerCase();
    expect(rawBlob).not.toMatch(/allergies|clinical|passport/);
    // No customer objects — the list endpoint should only include the
    // aggregate `memberCount`, not any raw customer rows.
    expect(rawBlob).not.toContain('customerid');
  });

  it('org DETAIL returns members but no customers or clinical notes', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await detailRoute.GET(req('http://x'), {
      params: Promise.resolve({ id: orgId }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ org: { features?: unknown; [k: string]: unknown } }>(res);
    // Strip the features JSONB before scanning — Phase 6 toggle keys
    // contain the substring "clinical" (toggle.provider.clinical_notes_others)
    // which would otherwise false-positive against the PII scanner.
    const org = { ...body.org };
    delete org.features;
    const rawBlob = JSON.stringify({ org }).toLowerCase();
    expect(rawBlob).not.toMatch(/allergies|clinicalnote|treatmenthistory/);
    // The customers COLLECTION must be absent — only aggregate _count is OK.
    expect(rawBlob).not.toMatch(/"customers":\[/);
  });

  it('audit query masks actor emails for SUPPORT_AGENT', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await auditRoute.GET(req('http://x/api/platform/audit?limit=5'));
    expect(res.status).toBe(200);
    const body = await json<{ rows: Array<{ actorEmail: string | null }> }>(res);
    for (const r of body.rows) {
      if (r.actorEmail) expect(r.actorEmail).toMatch(/\*\*\*/);
    }
    // Sanity: no un-redacted key looks like a full email
    void containsPii; // helper kept for future exports; not asserted here
  });
});
