import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { collectOpsMetrics, assertMetricsAreNumericOnly } from '@/lib/ops-metrics';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/health/ops — sanitized operational metrics for the production
// monitor (.github/workflows/production-monitor.yml).
//
// Auth: bearer CRON_SECRET, the same shape the scheduled workers under
// /api/cron use. There is no session here because the caller is a GitHub
// Actions runner, not a browser.
//
// What this returns: counts and ages only. lib/ops-metrics.ts documents each
// number, and assertMetricsAreNumericOnly() fails the request rather than
// emit a string, so no message body, recipient, token, IP or tenant
// identifier can reach a CI log even if someone later adds a field.
//
// Why it exists at all: /api/health proves the process is alive. It says
// nothing about whether the hourly housekeeping job has silently stopped
// draining the outbox, or whether the nightly retention job has stopped
// anonymising. Those failures are invisible from outside — this endpoint is
// how the monitor sees them.

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch;
  // the length of a bearer header is not the secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!bearerMatches(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const metrics = await collectOpsMetrics();
    // Belt and braces: refuse to answer rather than leak a non-numeric field.
    assertMetricsAreNumericOnly(metrics);
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (err) {
    // The error itself may quote SQL or a connection string; never echo it.
    log.error('health.ops.failed', { err: err instanceof Error ? err.name : 'unknown' });
    return NextResponse.json({ ok: false, error: 'metrics_unavailable' }, { status: 503 });
  }
}
