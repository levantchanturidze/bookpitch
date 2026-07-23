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
      const isPublic =
        path === '/signin' ||
        // Password reset landing page — needs to be reachable without a
        // session (that's the whole point).
        path === '/reset' ||
        // Self-service org onboarding — the whole point is that the caller
        // has no account yet.
        path === '/signup' ||
        path === '/api/onboard' ||
        // Offline page must load without auth so the SW can serve it when
        // the browser is offline (session cookies wouldn't reach us anyway).
        path === '/offline' ||
        // PWA icons + manifest — browsers fetch these without a session
        // cookie context, and they should never redirect to /signin.
        path === '/icon' ||
        path === '/apple-icon' ||
        path === '/icon-large' ||
        path.startsWith('/api/auth') ||
        // Uptime probe — no session cookie, no PII in the response.
        path === '/api/health' ||
        // Payment gateway webhooks are called by external services and
        // authenticate via HMAC in the handler itself.
        path.startsWith('/api/webhooks') ||
        // Scheduled workers (Vercel Cron, GitHub Actions, systemd timer…)
        // authenticate via a bearer secret in the handler.
        path.startsWith('/api/cron') ||
        // Mock gateway page + its callback are dev-only; a runtime notFound()
        // in the page itself hides them in production.
        path.startsWith('/dev/');
      if (isPublic) return true;
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
