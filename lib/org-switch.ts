import { cookies } from 'next/headers';
import { withoutRls } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Multi-org switcher. The JWT still carries the login-time organizationId +
// role, but the request pipeline PREFERS an "active org" cookie when it names
// a valid membership for the caller. This keeps auth.ts free of DB lookups on
// every request AND lets a user switch between orgs without re-signing-in.
//
// Cookie name: bp_active_org (org uuid). SameSite=Lax + HttpOnly so it can't
// be read from JS but ships on same-site navigation.
// -----------------------------------------------------------------------------

const COOKIE_NAME = 'bp_active_org';

export type MembershipSummary = {
  organizationId: string;
  organizationName: string;
  role: 'owner' | 'practitioner' | 'receptionist';
};

export async function listUserMemberships(userId: string): Promise<MembershipSummary[]> {
  return withoutRls(async (tx) => {
    const rows = await tx.membership.findMany({
      where: { userId },
      include: { organization: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      organizationId: r.organizationId,
      organizationName: r.organization.name,
      role: r.role,
    }));
  });
}

/**
 * Sets bp_active_org after verifying the target org is one the caller
 * belongs to. Throws InvalidInputError otherwise (never leaks whether the
 * org exists at all).
 */
export async function switchActiveOrg(userId: string, orgId: string): Promise<void> {
  const membership = await withoutRls((tx) =>
    tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      select: { id: true },
    }),
  );
  if (!membership) throw new InvalidInputError('you are not a member of that organization');
  const jar = await cookies();
  jar.set(COOKIE_NAME, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // 30-day lifetime; the DB check inside resolveActiveOrg keeps it
    // consistent if the membership is later revoked.
    maxAge: 30 * 24 * 3600,
  });
  log.info('org.switch', { userId, orgId });
}

/**
 * Given the JWT's default {orgId, role}, returns the effective org/role for
 * this request. If bp_active_org names a valid membership, prefer it; else
 * fall back to the JWT. Any invalid cookie is silently ignored.
 */
export async function resolveActiveOrg(
  session: ActiveSession,
): Promise<ActiveSession> {
  // cookies() throws outside a request scope (unit tests hit route handlers
  // directly, background jobs, etc.). Fall back to the JWT default silently.
  let cookieOrg: string | undefined;
  try {
    const jar = await cookies();
    cookieOrg = jar.get(COOKIE_NAME)?.value;
  } catch {
    return session;
  }
  if (!cookieOrg || cookieOrg === session.organizationId) return session;
  const membership = await withoutRls((tx) =>
    tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: cookieOrg, userId: session.userId } },
      select: { role: true },
    }),
  );
  if (!membership) return session;
  return {
    ...session,
    organizationId: cookieOrg,
    role: membership.role,
  };
}
