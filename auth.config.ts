import type { NextAuthConfig } from 'next-auth';

/**
 * Slim subset of the Auth.js config imported by `proxy.ts` (Next 16's Node
 * Proxy — formerly `middleware.ts` on Edge). Kept minimal so the proxy
 * bundle stays small: no Postgres driver, no argon2 native addon.
 *
 * The Credentials provider + DB lookup live in `auth.ts` and only run
 * inside Route Handlers where full Node capabilities are available.
 *
 * NOTE: no `authorized` callback here. The redirect-when-unauthenticated
 * logic lives in `proxy.ts` so we can control the response fully —
 * Auth.js's default authorized-returns-false path sets a
 * `__Secure-authjs.callback-url` cookie that we don't want and cannot
 * suppress from inside the callback.
 */
export const authConfig = {
  providers: [], // populated in auth.ts
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/signin' },
} satisfies NextAuthConfig;

/**
 * Paths that never require a session. Kept next to authConfig so the proxy
 * and any future guarding surface (server components, route handlers) can
 * agree on the same list.
 */
export function isPublicPath(path: string): boolean {
  return (
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
    path.startsWith('/dev/')
  );
}
