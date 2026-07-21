import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Auth.js `auth()` call BEFORE importing anything that uses it —
// otherwise lib/auth.ts captures the real one.
const authMock = vi.fn();
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Now safe to import — these transitively bind to the mocked auth().
const { requireRole, ForbiddenError, UnauthenticatedError } = await import('@/lib/auth');
const { GET: whoamiOwner } = await import('@/app/api/dev/whoami-owner/route');

function session(role: 'owner' | 'practitioner' | 'receptionist') {
  return {
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      email: `${role}@example.dev`,
      organizationId: '00000000-0000-0000-0000-000000000010',
      role,
    },
  };
}

describe('requireRole()', () => {
  beforeEach(() => authMock.mockReset());

  it('throws UnauthenticatedError when there is no session', async () => {
    authMock.mockResolvedValue(null);
    await expect(requireRole('owner')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('throws ForbiddenError when the role does not match', async () => {
    authMock.mockResolvedValue(session('receptionist'));
    await expect(requireRole('owner')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns the session when the role matches', async () => {
    authMock.mockResolvedValue(session('owner'));
    const s = await requireRole('owner');
    expect(s.role).toBe('owner');
  });

  it('accepts any of the listed roles', async () => {
    authMock.mockResolvedValue(session('receptionist'));
    const s = await requireRole('owner', 'receptionist');
    expect(s.role).toBe('receptionist');
  });
});

describe('GET /api/dev/whoami-owner (integration through Route Handler)', () => {
  beforeEach(() => authMock.mockReset());

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await whoamiOwner();
    expect(res.status).toBe(401);
  });

  it('returns 403 for a receptionist', async () => {
    authMock.mockResolvedValue(session('receptionist'));
    const res = await whoamiOwner();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/owner/);
  });

  it('returns 200 for an owner and surfaces the session', async () => {
    authMock.mockResolvedValue(session('owner'));
    const res = await whoamiOwner();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.session.role).toBe('owner');
  });
});
