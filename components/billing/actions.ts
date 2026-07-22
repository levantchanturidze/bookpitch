'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth';
import { settleCash, startCardCheckout } from '@/lib/payments/service';

// Server Actions used by the Billing UI. The card path returns the gateway
// URL by throwing NEXT_REDIRECT so the browser follows it directly — no JSON
// round-trip through the client.

export async function startCardCheckoutAction(fd: FormData) {
  const session = await requireRole('owner', 'receptionist');
  const appointmentId = String(fd.get('appointmentId') ?? '');
  const { redirectUrl } = await startCardCheckout(session, appointmentId);
  redirect(redirectUrl);
}

export async function settleCashAction(fd: FormData) {
  const session = await requireRole('owner', 'receptionist');
  const appointmentId = String(fd.get('appointmentId') ?? '');
  await settleCash(session, appointmentId);
  revalidatePath('/billing');
  revalidatePath('/scheduler');
}
