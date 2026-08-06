'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { settleCash, startCardCheckout } from '@/lib/payments/service';

// Server Actions used by the Billing UI. The card path returns the gateway
// URL by throwing NEXT_REDIRECT so the browser follows it directly — no JSON
// round-trip through the client.

export async function startCardCheckoutAction(fd: FormData) {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'payment.charge',
    { organizationId: ctx.activeOrganizationId! },
    'payments',
  );
  const appointmentId = String(fd.get('appointmentId') ?? '');
  const { redirectUrl } = await startCardCheckout(ctxToSession(ctx), appointmentId);
  redirect(redirectUrl);
}

export async function settleCashAction(fd: FormData) {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'payment.charge',
    { organizationId: ctx.activeOrganizationId! },
    'payments',
  );
  const appointmentId = String(fd.get('appointmentId') ?? '');
  await settleCash(ctxToSession(ctx), appointmentId);
  revalidatePath('/billing');
  revalidatePath('/scheduler');
}
