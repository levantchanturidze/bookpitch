import type { NextRequest } from 'next/server';
import { requireRole, withApi, InvalidInputError } from '@/lib/auth';
import { startCheckout } from '@/lib/billing/service';
import type { PlanId } from '@/lib/billing/plans';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/billing/checkout  { plan: 'pro' | 'clinic' } → { url }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const body = (await req.json().catch(() => null)) as { plan?: unknown } | null;
    const plan = body?.plan as PlanId | undefined;
    if (!plan) throw new InvalidInputError('plan is required');
    return startCheckout(session, plan);
  });
}
