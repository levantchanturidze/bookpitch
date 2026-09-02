import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The commit this deployment was built from.
 *
 * Vercel injects VERCEL_GIT_COMMIT_SHA at build time. The fallbacks let a
 * self-hosted or local build report something meaningful; an empty string
 * means "unknown", which callers must treat as evidence-absent rather than
 * as agreement.
 */
export const RELEASE_SHA_HEADER = 'x-bookpitch-release';

export function deployedReleaseSha(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (env.VERCEL_GIT_COMMIT_SHA ?? env.GITHUB_SHA ?? env.RELEASE_SHA ?? '').trim();
}

// GET /api/health — minimal public liveness probe.
//
// Returns exactly { ok: true } when the application process is alive. The BODY
// is deliberately unchanged: scripts/production-monitor.mjs asserts it matches
// `{"ok":true}` exactly and treats any extra field as a leak, which is how it
// would catch build info appearing in a public response.
//
// The release commit goes in a RESPONSE HEADER instead. It is needed because
// the soak controller has to prove that `bookpitch.ge` and `www.bookpitch.ge`
// are serving the exact deployment under soak — before this, the check
// accepted any HTTP 200, so a healthy response from a completely different
// deployment satisfied it.
//
// A commit SHA is not sensitive: this repository's history is the operator's
// own, the SHA reveals nothing about configuration or topology, and it is
// already public on every GitHub Deployment record. It is a header rather than
// a body field so no existing consumer's parsing changes.
export async function GET() {
  const res = NextResponse.json({ ok: true });
  const sha = deployedReleaseSha();
  if (sha) res.headers.set(RELEASE_SHA_HEADER, sha);
  return res;
}
