import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { submitPublicBooking } from '@/lib/public-booking';
import { InvalidInputError } from '@/lib/auth';
import { RateLimitedError } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/book — unauthenticated. Body:
// { slug, staffId, serviceId, startsAt, customerName,
//   customerEmail?, customerPhone?, notes?, consented }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  try {
    const result = await submitPublicBooking({
      slug: String(body.slug ?? ''),
      staffId: String(body.staffId ?? ''),
      serviceId: String(body.serviceId ?? ''),
      startsAtIso: String(body.startsAt ?? ''),
      customerName: String(body.customerName ?? ''),
      customerEmail: body.customerEmail ? String(body.customerEmail) : undefined,
      customerPhone: body.customerPhone ? String(body.customerPhone) : undefined,
      notes: body.notes ? String(body.notes) : undefined,
      consented: body.consented === true,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // GiST double-booking → 409.
    const msg = (err as { message?: string }).message ?? '';
    if (msg.includes('no_staff_double_booking') || msg.includes('23P01')) {
      return NextResponse.json({ error: 'slot_taken' }, { status: 409 });
    }
    throw err;
  }
}
