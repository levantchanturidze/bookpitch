import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { draftAppointment } from '@/lib/assistant/draft';

// POST /api/assistant/draft
// Body: { prompt: string, locationId: string, referenceDate?: string }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.read:contact',
      { organizationId: ctx.activeOrganizationId! },
      'assistant',
    );
    const body = (await req.json().catch(() => null)) as {
      prompt?: unknown;
      locationId?: unknown;
      referenceDate?: unknown;
    } | null;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const locationId = typeof body?.locationId === 'string' ? body.locationId : '';
    if (!prompt) throw new InvalidInputError('prompt is required');
    if (!locationId) throw new InvalidInputError('locationId is required');
    const referenceDate =
      typeof body?.referenceDate === 'string' ? new Date(body.referenceDate) : new Date();
    return draftAppointment(ctxToSession(ctx), locationId, prompt, referenceDate);
  });
}
