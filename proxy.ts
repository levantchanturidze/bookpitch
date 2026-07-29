import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';
import { isPublicPath } from '@/auth.config';

// Next 16 Proxy — runs on the Node.js runtime by default (unlike the
// old `middleware.ts` which was Edge-only). We still import the Node-free
// authConfig split so the `authorized` callback stays small; the crypto
// requirements of next-auth's JWT signing are satisfied by Node's built-in
// `node:crypto` at request time.
const { auth } = NextAuth(authConfig);

// Wrap the Auth.js middleware so we control the redirect response fully.
// Auth.js's default `authorized`-returns-false path sets a
// `__Secure-authjs.callback-url` cookie via its own post-processing chain
// which cannot be suppressed from inside the callback. Doing the redirect
// here — before Auth.js's cookie setter runs — means the cookie is never
// added, and the URL bar stays as a clean `/signin` with no query string.
export default auth((req) => {
  if (isPublicPath(req.nextUrl.pathname)) return NextResponse.next();
  if (req.auth?.user) return NextResponse.next();
  return NextResponse.redirect(new URL('/signin', req.nextUrl.origin));
});

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
