import { InvalidInputError } from '@/lib/auth';
import { withOrg } from '@/lib/db';

// -----------------------------------------------------------------------------
// Per-org monthly assistant call quota. Prevents a runaway integration or
// abusive tenant from billing the whole account into oblivion.
//
// Storage: `assistant_usage` (org, year_month, count) — one row per month.
// Increment is atomic via UPSERT so concurrent calls can't skip.
// Cap: env ASSISTANT_MONTHLY_CAP_PER_ORG (integer, default 500). A cap of 0
//      means "disabled" — useful for staging.
// -----------------------------------------------------------------------------

const DEFAULT_CAP = 500;

export class AssistantQuotaExceededError extends InvalidInputError {
  constructor(cap: number) {
    super(`Assistant monthly limit reached (${cap} requests). Try again next month.`);
    this.name = 'AssistantQuotaExceededError';
  }
}

export function currentYearMonth(now: Date = new Date()): number {
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
}

function readCap(): number {
  const raw = process.env.ASSISTANT_MONTHLY_CAP_PER_ORG;
  if (!raw) return DEFAULT_CAP;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_CAP;
  return n;
}

/**
 * Reserves one assistant call for the org. Throws AssistantQuotaExceededError
 * when the monthly cap is reached. Returns the post-increment count so callers
 * can log/telemeter.
 */
export async function consumeAssistantQuota(
  orgId: string,
  now: Date = new Date(),
): Promise<{ count: number; cap: number }> {
  const cap = readCap();
  if (cap === 0) return { count: 0, cap: 0 };
  const yearMonth = currentYearMonth(now);

  const row = await withOrg(orgId, (tx) =>
    tx.assistantUsage.upsert({
      where: { organizationId_yearMonth: { organizationId: orgId, yearMonth } },
      create: { organizationId: orgId, yearMonth, count: 1 },
      update: { count: { increment: 1 }, updatedAt: new Date() },
      select: { count: true },
    }),
  );

  if (row.count > cap) {
    throw new AssistantQuotaExceededError(cap);
  }
  return { count: row.count, cap };
}
