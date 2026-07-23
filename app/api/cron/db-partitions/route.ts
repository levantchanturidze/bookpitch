import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { prismaAdmin } from '@/lib/db';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/cron/db-partitions
//
// Bearer CRON_SECRET. Creates the next 3 monthly partitions for
// partitioned tables (currently just audit_log). Safe to run daily;
// bp_create_monthly_partition() is idempotent via IF NOT EXISTS.
//
// Runs against ADMIN URL because the partitioned parent's DDL needs
// owner privileges, not the app role.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const created: string[] = [];
  const now = new Date();
  for (let i = 0; i <= 3; i++) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const iso = target.toISOString().slice(0, 10);
    await prismaAdmin.$executeRawUnsafe(
      `SELECT bp_create_monthly_partition('audit_log'::regclass, '${iso}'::date);`,
    );
    created.push(iso.slice(0, 7));
  }
  log.info('db_partitions.rolled', { created });
  return NextResponse.json({ ok: true, created });
}
