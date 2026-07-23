import { InvalidInputError } from '@/lib/auth';
import { withOrg } from '@/lib/db';

// -----------------------------------------------------------------------------
// Per-org fixed-window rate limiter. 1-minute windows keyed by
// date_trunc('minute'). Upsert-and-increment inside withOrg so the RLS
// policy on rate_limit is what stops cross-tenant leakage.
//
// A limit of 0 means "disabled" (useful for tests / staging). The default
// window length is 60s to keep the math trivial.
// -----------------------------------------------------------------------------

export class RateLimitedError extends InvalidInputError {
  constructor(bucket: string, limit: number) {
    super(`Rate limit exceeded for ${bucket} (${limit}/min). Try again in a moment.`);
    this.name = 'RateLimitedError';
  }
}

function windowStart(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setUTCSeconds(0, 0);
  return d;
}

/**
 * Consumes one token in (orgId, bucket) for the current 1-minute window.
 * Throws RateLimitedError if the post-increment count would exceed `limit`.
 * `limit <= 0` disables the check (no row is written).
 */
export async function consumeRateLimit(
  orgId: string,
  bucket: string,
  limit: number,
  now: Date = new Date(),
): Promise<{ count: number; limit: number }> {
  if (limit <= 0) return { count: 0, limit: 0 };
  const start = windowStart(now);

  const row = await withOrg(orgId, (tx) =>
    tx.rateLimit.upsert({
      where: {
        organizationId_bucket_windowStart: {
          organizationId: orgId,
          bucket,
          windowStart: start,
        },
      },
      create: { organizationId: orgId, bucket, windowStart: start, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    }),
  );
  if (row.count > limit) throw new RateLimitedError(bucket, limit);
  return { count: row.count, limit };
}

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return n;
}

export const RateLimit = {
  assistant: (orgId: string) =>
    consumeRateLimit(orgId, 'assistant', envLimit('ASSISTANT_RPM_PER_ORG', 20)),
  messaging: (orgId: string) =>
    consumeRateLimit(orgId, 'messaging', envLimit('MESSAGING_RPM_PER_ORG', 60)),
};
