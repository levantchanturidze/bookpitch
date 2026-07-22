import { NextResponse } from 'next/server';
import { prismaAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/health — uptime + DB reachability probe. Meant for Vercel
// health checks / external monitors. Public (no auth) and cheap — a
// single `SELECT 1` and a timestamp. Never returns tenant data.
export async function GET() {
  const startedAt = Date.now();
  try {
    await prismaAdmin.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      dbLatencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        timestamp: new Date().toISOString(),
        error: (err as Error).message,
      },
      { status: 503 },
    );
  }
}
