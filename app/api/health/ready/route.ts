import { NextResponse } from 'next/server';
// eslint-disable-next-line no-restricted-imports -- readiness probe requires all clients
import { prismaApp, unsafePrismaAdmin, prismaLogin } from '@/lib/db';
import { requireAuthContext, perm } from '@/lib/rbac';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/health/ready — protected DB readiness probe for operators.
//
// Requires an authenticated SUPER_ADMIN session. Returns sanitized
// connection-category diagnostics (ok/unavailable per role-category, latency
// bucket, sanitized error category) without exposing env-var names, connection
// strings, raw SQL error messages, or exact SQLSTATE codes.
//
// Latency is reported in bucketed form (fast / moderate / slow / timeout) to
// prevent timing side-channels that could aid targeted DoS.
//
// This endpoint is NOT in the public allowlist (isPublicPath returns false for
// it). The proxy redirects unauthenticated callers to /signin.

type RoleCategory = 'app' | 'admin' | 'login';

type ReadinessCheck = {
  category: RoleCategory;
  ok: boolean;
  latencyBucket: 'fast' | 'moderate' | 'slow' | 'timeout';
  errorCategory?: 'auth' | 'connection' | 'query' | 'unknown';
};

function latencyBucket(ms: number): ReadinessCheck['latencyBucket'] {
  if (ms < 100) return 'fast';
  if (ms < 500) return 'moderate';
  if (ms < 3000) return 'slow';
  return 'timeout';
}

function sanitizeError(err: unknown): ReadinessCheck['errorCategory'] {
  const msg = (err as { message?: string }).message ?? '';
  // Map Postgres SQLSTATE classes to safe categories without exposing the raw code.
  if (/28[P0-9]{3}|password|authentication|auth/i.test(msg)) return 'auth';
  if (/connection|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) return 'connection';
  if (/syntax|relation|column|type/i.test(msg)) return 'query';
  return 'unknown';
}

async function probeCategory(
  client: typeof prismaApp,
  category: RoleCategory,
): Promise<ReadinessCheck> {
  const t0 = Date.now();
  try {
    await client.$queryRaw`SELECT 1`;
    return { category, ok: true, latencyBucket: latencyBucket(Date.now() - t0) };
  } catch (err) {
    const ms = Date.now() - t0;
    // Log full error server-side only; never in the response.
    log.warn('health.ready.probe_failed', { category });
    return {
      category,
      ok: false,
      latencyBucket: latencyBucket(ms),
      errorCategory: sanitizeError(err),
    };
  }
}

export async function GET() {
  // Require a valid authenticated session. requireAuthContext throws/redirects
  // for unauthenticated callers; the proxy also enforces this.
  const ctx = await requireAuthContext();
  if (!ctx.platformPermissions.has(perm('platform.config.manage'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const [appCheck, adminCheck, loginCheck] = await Promise.all([
    probeCategory(prismaApp, 'app'),
    probeCategory(unsafePrismaAdmin, 'admin'),
    probeCategory(prismaLogin, 'login'),
  ]);

  const allOk = appCheck.ok && adminCheck.ok && loginCheck.ok;
  return NextResponse.json(
    {
      ok: allOk,
      timestamp: new Date().toISOString(),
      checks: [appCheck, adminCheck, loginCheck],
    },
    { status: allOk ? 200 : 503 },
  );
}
