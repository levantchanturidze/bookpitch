import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { verify } from '@node-rs/argon2';

import { authConfig } from '@/auth.config';
import { prismaAdmin, withoutRls } from '@/lib/db';

// -----------------------------------------------------------------------------
// JWT + Session shape (Phase 4).
//
// Canonical claims:
//   • activeOrganizationId — the tenant this request is acting inside.
//   • membershipId         — the row in `memberships` backing the caller's
//                            role + branch scoping. AuthContext is keyed on this.
//   • platformRoleId       — nullable pointer to a platform-plane role
//                            (SUPER_ADMIN, PLATFORM_ADMIN, …). NULL for
//                            everyone today; populated in Phase 5.
//
// Legacy `organizationId` + `role` aliases were removed in Phase 4
// (migration 20260728120000_rbac_phase4_reauth bumped every sessionVersion
// so any surviving pre-Phase-4 JWT gets rejected within SV_TTL_MS).
// -----------------------------------------------------------------------------
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      activeOrganizationId: string | null;
      membershipId: string | null;
      platformRoleId: string | null;
    } & DefaultSession['user'];
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    userId: string;
    email: string;
    activeOrganizationId: string | null;
    membershipId: string | null;
    platformRoleId: string | null;
    sessionVersion: number;
  }
}

// Small in-process cache to keep session() cheap: 5-second TTL so a fresh
// password reset (or an org-switch sessionVersion bump) propagates quickly
// but we don't hit the DB on every request.
type CacheEntry = { version: number; at: number };
const sessionVersionCache = new Map<string, CacheEntry>();
const SV_TTL_MS = 5_000;
async function getCurrentSessionVersion(userId: string): Promise<number | null> {
  const now = Date.now();
  const hit = sessionVersionCache.get(userId);
  if (hit && now - hit.at < SV_TTL_MS) return hit.version;
  const row = await withoutRls((tx) =>
    tx.appUser.findUnique({ where: { id: userId }, select: { sessionVersion: true } }),
  );
  if (!row) return null;
  sessionVersionCache.set(userId, { version: row.sessionVersion, at: now });
  return row.sessionVersion;
}

/** Test-only. Drop the sessionVersion cache so a bump inside a test flushes
 *  immediately without waiting SV_TTL_MS. */
export function __clearSessionVersionCache(): void {
  sessionVersionCache.clear();
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prismaAdmin),
  providers: [
    Credentials({
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
        // Optional target org. Populated by the org-switch flow
        // (lib/org-switch.ts) which triggers a fresh sign-in with the
        // desired org selected. Absent → picks the first active membership.
        orgId:    { label: 'orgId',    type: 'text' },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        const requestedOrgId = typeof credentials?.orgId === 'string' && credentials.orgId
          ? credentials.orgId
          : null;
        if (typeof email !== 'string' || typeof password !== 'string') return null;

        // Login predates any org context — bypass RLS to find the user +
        // (optionally) their target membership.
        const user = await withoutRls(async (tx) => {
          return tx.appUser.findUnique({
            where: { email },
            include: {
              memberships: requestedOrgId
                ? { where: { organizationId: requestedOrgId, status: 'active' }, take: 1 }
                : { orderBy: { createdAt: 'asc' }, take: 1, where: { status: 'active' } },
            },
          });
        });

        if (!user?.passwordHash || user.memberships.length === 0) return null;
        const ok = await verify(user.passwordHash, password);
        if (!ok) return null;

        const membership = user.memberships[0];
        return {
          id: user.id,
          email: user.email,
          name: user.fullName ?? undefined,
          activeOrganizationId: membership.organizationId,
          membershipId: membership.id,
          platformRoleId: user.platformRoleId,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      if (user) {
        const u = user as {
          id: string;
          email: string;
          activeOrganizationId: string;
          membershipId: string;
          platformRoleId: string | null;
          sessionVersion: number;
        };
        token.userId = u.id;
        token.email = u.email;
        token.activeOrganizationId = u.activeOrganizationId;
        token.membershipId = u.membershipId;
        token.platformRoleId = u.platformRoleId;
        token.sessionVersion = u.sessionVersion ?? 1;
      }
      return token;
    },
    async session({ session, token }) {
      // Session revocation: reject any JWT whose sessionVersion is stale.
      // Same lever is used to force re-auth after an org switch
      // (lib/org-switch.ts bumps sessionVersion).
      const current = await getCurrentSessionVersion(token.userId);
      if (current === null || current !== token.sessionVersion) {
        return { ...session, user: undefined as unknown as typeof session.user };
      }
      session.user.id                   = token.userId;
      session.user.email                = token.email ?? session.user.email;
      session.user.activeOrganizationId = token.activeOrganizationId;
      session.user.membershipId         = token.membershipId;
      session.user.platformRoleId       = token.platformRoleId;
      return session;
    },
  },
});
