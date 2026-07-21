import NextAuth from 'next-auth';
import { authConfig } from '@/auth.config';

// Edge-safe: only the Node-free authConfig is imported here.
// The `authorized` callback redirects unauthenticated requests to /signin.
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
