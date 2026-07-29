import { NextResponse } from 'next/server';
import type { NextAuthConfig } from 'next-auth';

/**
 * Slim subset of the Auth.js config imported by `proxy.ts` (Next 16's Node
 * Proxy — formerly `middleware.ts` on Edge). Kept minimal so the proxy
 * bundle stays small: no Postgres driver, no argon2 native addon.
 *
 * The Credentials provider + DB lookup live in `auth.ts` and only run
 * inside Route Handlers where full Node capabilities are available.
 */
export const authConfig = {
  providers: [], // populated in auth.ts
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/signin' },
  callbacks: {
    // Runs inside proxy.ts on every matched request. Returning `true` allows
    // the request through. Unauthenticated hits on a protected path get an
    // EXPLICIT redirect to /signin with no `?callbackUrl=` query and no
    // `__Secure-authjs.callback-url` cookie — post-signin routing is
    // handled by the sign-in action itself (redirectTo: '/'), so leaking
    // the origin URL into the address bar or cookie would be noise.
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
        // Invitation acceptance — invitee doesn't have a session yet.
        path === '/invite' ||
        path === '/api/invitations/accept' ||
        // Public booking widget — customer has no session.
        path.startsWith('/book/') ||
        path === '/api/public/book' ||
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
      if (auth?.user) return true;
      const res = NextResponse.redirect(new URL('/signin', nextUrl.origin));
      // Auth.js otherwise sets a `__Secure-authjs.callback-url` cookie
      // holding the origin URL so the sign-in page can bounce the user
      // back after login. The sign-in server action already redirects to
      // `/` unconditionally, so this cookie is unused noise. Expire both
      // names (secure prefix for HTTPS, plain for HTTP dev) so the browser
      // drops any existing value.
      res.cookies.set('__Secure-authjs.callback-url', '', { maxAge: 0, path: '/' });
      res.cookies.set('authjs.callback-url', '', { maxAge: 0, path: '/' });
      return res;
    },
  },
} satisfies NextAuthConfig;
