import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/health — minimal public liveness probe.
//
// Returns exactly { ok: true } when the application process is alive.
// This is the ONLY information exposed publicly: no DB state, no build
// version, no environment names, no connection topology.
//
// Detailed readiness: /api/health/ready (requires SUPER_ADMIN session).
export async function GET() {
  return NextResponse.json({ ok: true });
}
