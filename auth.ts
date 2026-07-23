import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { verify } from '@node-rs/argon2';

import { authConfig } from '@/auth.config';
import { prismaAdmin, withoutRls } from '@/lib/db';
import type { UserRole } from '@prisma/client';

// -----------------------------------------------------------------------------
// Session augmentation — organizationId + role travel with every request.
// -----------------------------------------------------------------------------
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      organizationId: string;
      role: UserRole;
    } & DefaultSession['user'];
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    userId: string;
    organizationId: string;
    role: UserRole;
    email: string;
    sessionVersion: number;
  }
}

// Small in-process cache to keep session() cheap: 5-second TTL so a fresh
// password reset propagates quickly but we don't hit the DB on every request.
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // Prisma adapter owns user CRUD + VerificationTokens (password reset,
  // magic links). Sessions themselves stay JWT — the Credentials provider
  // requires the JWT strategy per Auth.js docs.
  adapter: PrismaAdapter(prismaAdmin),
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== 'string' || typeof password !== 'string') {
          return null;
        }

        // Login predates any org context — bypass RLS to find the user +
        // their (first) membership. Multi-org: expose an org-picker later.
        const user = await withoutRls(async (tx) => {
          return tx.appUser.findUnique({
            where: { email },
            include: {
              memberships: {
                orderBy: { createdAt: 'asc' },
                take: 1,
              },
            },
          });
        });

        if (!user?.passwordHash || user.memberships.length === 0) {
          return null;
        }
        const ok = await verify(user.passwordHash, password);
        if (!ok) return null;

        const membership = user.memberships[0];
        return {
          id: user.id,
          email: user.email,
          name: user.fullName ?? undefined,
          organizationId: membership.organizationId,
          role: membership.role,
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
          organizationId: string;
          role: UserRole;
          sessionVersion: number;
        };
        token.userId = u.id;
        token.email = u.email;
        token.organizationId = u.organizationId;
        token.role = u.role;
        token.sessionVersion = u.sessionVersion ?? 1;
      }
      return token;
    },
    async session({ session, token }) {
      // Session revocation: the token was signed against a specific
      // sessionVersion. If the DB now has a higher version (password reset
      // or admin revoke), the caller is holding a stale JWT — surface no
      // user, which sends them back through /signin.
      const current = await getCurrentSessionVersion(token.userId);
      if (current === null || current !== token.sessionVersion) {
        return { ...session, user: undefined as unknown as typeof session.user };
      }
      session.user.id = token.userId;
      session.user.email = token.email ?? session.user.email;
      session.user.organizationId = token.organizationId;
      session.user.role = token.role;
      return session;
    },
  },
});
