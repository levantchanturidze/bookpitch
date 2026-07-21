import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-safe subset of the Auth.js config. Split from `auth.ts` so it can be
 * imported by `middleware.ts` (which runs on the Edge runtime and cannot use
 * Node-only modules like the Postgres driver or the argon2 native addon).
 *
 * The Credentials provider + DB lookup live in `auth.ts` and only run in the
 * Node runtime (Route Handlers).
 */
export const authConfig = {
  providers: [], // populated in auth.ts
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/signin' },
  callbacks: {
    // Runs in middleware on every matched request. Returning false tells
    // Auth.js to redirect to `pages.signIn`.
    authorized({ auth, request: { nextUrl } }) {
      const path = nextUrl.pathname;
      const isPublic = path === '/signin' || path.startsWith('/api/auth');
      if (isPublic) return true;
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
