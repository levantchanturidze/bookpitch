import { NextResponse } from 'next/server';
// eslint-disable-next-line no-restricted-imports -- SEC-007: health probe
// needs to test prismaLogin reachability so the buildAuthContext hot path
// can be diagnosed without triggering a real request. Boot log alone tells
// us the client was BUILT; the health probe tells us it can actually query.
import { prismaApp, unsafePrismaAdmin, prismaLogin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/health — uptime + per-connection DB reachability probe.
//
// Tests each Prisma client separately and reports by ENV VAR NAME. Never
// returns the connection string or any secret. On failure, the response
// says exactly which env var's URL failed to authenticate — turning the
// next "500 during rotation" incident into a thirty-second diagnosis
// (see docs/rbac-findings.md F-12 for the incident this fixed).
//
// Response shape:
//   { ok: true,  timestamp, checks: { DATABASE_URL_APP_NOBYPASSRLS: {ok, latencyMs},
//                                     DATABASE_URL_SUPERUSER_TXPOOL: {ok, latencyMs} } }
// The admin-side key mirrors whichever env var is actually powering
// unsafePrismaAdmin (new tx-pool name preferred, falls back to session,
// then to the legacy ADMIN_RUNTIME_DATABASE_URL / ADMIN_DATABASE_URL).
//
// Response body NEVER contains a URL, password, or full error message.
// Error field is just the Postgres error code ('28P01' = auth failed,
// 'XX000' = pool exhausted, etc.). Anyone reading /api/health cannot
// derive credentials from what's there.
type AppLabel = 'DATABASE_URL_APP_NOBYPASSRLS' | 'DATABASE_URL';
type AdminLabel =
  | 'DATABASE_URL_SUPERUSER_TXPOOL'
  | 'DATABASE_URL_SUPERUSER_SESSION'
  | 'ADMIN_RUNTIME_DATABASE_URL'
  | 'ADMIN_DATABASE_URL';
type LoginLabel = 'DATABASE_URL_LOGIN' | 'DATABASE_URL_LOGIN (fallback→admin)';
type CheckResult = {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
};

async function probe(
  client: typeof prismaApp,
  label: AppLabel | AdminLabel | LoginLabel,
): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    // Extract just the Postgres SQLSTATE if present. Never surface the
    // message (which can include the connection string).
    const msg = (err as { message?: string }).message ?? '';
    const codeMatch = msg.match(/Code:\s*[`"']?([A-Z0-9]{5})[`"']?/);
    const code = codeMatch ? codeMatch[1] : 'unknown';
    // Log the full error server-side (Vercel logs) for triage, keyed by
    // the label — never in the response body.
    // eslint-disable-next-line no-console
    console.error(`[health.${label}] check failed: ${msg.slice(0, 300)}`);
    return { ok: false, latencyMs: Date.now() - t0, errorCode: code };
  }
}

export async function GET() {
  // Report by the env var that was actually used to build the client so the
  // F-12 diagnosis flow points at the right rotation target. Precedence
  // matches lib/db.ts (new names first, legacy names as fallback). Both
  // sides now name the actually-used variable — no hardcoded label.
  const appLabel: AppLabel =
    process.env.DATABASE_URL_APP_NOBYPASSRLS ? 'DATABASE_URL_APP_NOBYPASSRLS'
                                             : 'DATABASE_URL';
  const adminLabel: AdminLabel =
    process.env.DATABASE_URL_SUPERUSER_TXPOOL   ? 'DATABASE_URL_SUPERUSER_TXPOOL'   :
    process.env.DATABASE_URL_SUPERUSER_SESSION  ? 'DATABASE_URL_SUPERUSER_SESSION'  :
    process.env.ADMIN_RUNTIME_DATABASE_URL      ? 'ADMIN_RUNTIME_DATABASE_URL'      :
                                                  'ADMIN_DATABASE_URL';
  // If DATABASE_URL_LOGIN is unset, prismaLogin aliases to unsafePrismaAdmin
  // (same connection). Report that as fallback so operators can tell
  // whether the narrow role is being exercised.
  const loginRaw = process.env.DATABASE_URL_LOGIN;
  const loginActive = loginRaw && loginRaw.trim().length > 0;
  const loginLabel: LoginLabel = loginActive
    ? 'DATABASE_URL_LOGIN'
    : 'DATABASE_URL_LOGIN (fallback→admin)';

  // Probe all three clients in parallel — DB slowness on one shouldn't cascade.
  const [appCheck, adminCheck, loginCheck] = await Promise.all([
    probe(prismaApp, appLabel),
    probe(unsafePrismaAdmin, adminLabel),
    probe(prismaLogin, loginLabel),
  ]);

  const ok = appCheck.ok && adminCheck.ok && loginCheck.ok;
  return NextResponse.json(
    {
      ok,
      timestamp: new Date().toISOString(),
      checks: {
        [appLabel]: appCheck,
        [adminLabel]: adminCheck,
        [loginLabel]: loginCheck,
      },
    },
    { status: ok ? 200 : 503 },
  );
}
