import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { verify } from '@node-rs/argon2';

import { authConfig } from '@/auth.config';
import { withoutRls } from '@/lib/db';
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
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
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
        };
        token.userId = u.id;
        token.email = u.email;
        token.organizationId = u.organizationId;
        token.role = u.role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId;
      session.user.email = token.email ?? session.user.email;
      session.user.organizationId = token.organizationId;
      session.user.role = token.role;
      return session;
    },
  },
});
