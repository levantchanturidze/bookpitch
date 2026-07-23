import type { NextRequest } from 'next/server';
import { requireRole, withApi, InvalidInputError } from '@/lib/auth';
import { addToWaitlist, listWaitlist } from '@/lib/waitlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/waitlist — staff-visible.
export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner', 'practitioner', 'receptionist');
    const rows = await listWaitlist(session);
    return { waitlist: rows };
  });
}

// POST /api/waitlist { customerId, staffId?, serviceId?, locationId?,
//                     preferredFrom, preferredTo, notes? }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner', 'practitioner', 'receptionist');
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new InvalidInputError('invalid body');
    const iso = (k: string) => (typeof body[k] === 'string' ? new Date(String(body[k])) : null);
    const preferredFrom = iso('preferredFrom');
    const preferredTo = iso('preferredTo');
    if (!preferredFrom || !preferredTo) throw new InvalidInputError('window is required');
    return addToWaitlist(session, {
      customerId: String(body.customerId ?? ''),
      locationId: body.locationId ? String(body.locationId) : undefined,
      staffId: body.staffId ? String(body.staffId) : undefined,
      serviceId: body.serviceId ? String(body.serviceId) : undefined,
      preferredFrom,
      preferredTo,
      notes: body.notes ? String(body.notes) : undefined,
    });
  });
}
