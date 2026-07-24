import NextAuth from 'next-auth';
import { authConfig } from '@/auth.config';

// Next 16 Proxy — runs on the Node.js runtime by default (unlike the
// old `middleware.ts` which was Edge-only). We still import the Node-free
// authConfig split so the `authorized` callback stays small; the crypto
// requirements of next-auth's JWT signing are satisfied by Node's built-in
// `node:crypto` at request time.
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
