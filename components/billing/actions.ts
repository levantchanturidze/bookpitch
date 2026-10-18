'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { settleCash, startCardCheckout } from '@/lib/payments/service';
import type { ActionResult } from '@/lib/action-result';
import { safeAction } from '@/lib/safe-action';

// Server Actions used by the Billing UI. The card path returns the gateway
// URL by throwing NEXT_REDIRECT so the browser follows it directly — no JSON
// round-trip through the client.

async function startCardCheckoutImpl(fd: FormData) {
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

async function settleCashImpl(fd: FormData) {
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

// -----------------------------------------------------------------------------
// The exported actions return an ActionResult; a refusal no longer escapes as
// an HTTP 500 with a digest. The card path still navigates: redirect() throws
// Next's own control-flow error, which safeAction() passes through untouched.
// -----------------------------------------------------------------------------

export async function startCardCheckoutAction(fd: FormData): Promise<ActionResult> {
  return safeAction('billing.startCardCheckout', () => startCardCheckoutImpl(fd));
}

export async function settleCashAction(fd: FormData): Promise<ActionResult> {
  return safeAction('billing.settleCash', () => settleCashImpl(fd));
}
