import type { NextRequest } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { setAvailability, type AvailabilityWindow } from '@/lib/admin';

// PUT /api/admin/staff/[id]/availability
// Body: { windows: Array<{ weekday, startTime, endTime }> } — replaces all
// availability windows for the staff atomically.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { windows?: unknown };
    if (!Array.isArray(body.windows)) throw new InvalidInputError('windows must be an array');
    await setAvailability(session, id, body.windows as AvailabilityWindow[]);
    return { ok: true };
  });
}
