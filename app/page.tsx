import { redirect } from 'next/navigation';
import { requireAuthContext, perm } from '@/lib/rbac';
import { UnauthenticatedError } from '@/lib/auth';

// Root landing: pick the first page the caller has permission for so no role
// lands on a 500 (F-10). Order matters — first hit wins.
//   • SUPER_ADMIN, PLATFORM_ADMIN, SUPPORT_AGENT, BILLING_MANAGER
//         → /platform (they have no org membership; app-plane layout would
//           redirect them there anyway)
//   • Anyone with a booking.read grant (any scope) → /scheduler
//   • Anyone with client.read (any tier) → /patients
//   • Anyone with report.own → /reports (if we had it — ACCOUNTANT lands here)
//   • Fallback: /settings (org owner can always settings-manage; anyone
//     else with zero grants shouldn't be signed in on the org plane)
export default async function Root() {
  let ctx;
  try {
    ctx = await requireAuthContext();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect('/signin');
    throw err;
  }

  // Platform-plane user with no active org.
  if (!ctx.activeOrganizationId && ctx.platformPermissions.size > 0) {
    redirect('/platform');
  }

  const has = (key: string) => ctx.permissions.has(perm(key));

  // Scheduler needs booking.read at some scope. PROVIDER is :own,
  // FRONT_DESK is :branch, OWNER/ADMIN/BM are :branch or :org.
  if (
    has('booking.read:own') || has('booking.read:branch') || has('booking.read:org')
  ) {
    redirect('/scheduler');
  }

  // Patients page needs client.read:contact.
  if (has('client.read:contact') || has('client.read:full') || has('client.read:basic')) {
    redirect('/patients');
  }

  // ACCOUNTANT + reporting roles: land in billing (they hold org.billing.read).
  if (has('org.billing.read') || has('org.billing.manage')) {
    redirect('/settings/billing');
  }

  // Nothing matched. Send to settings; the visibleNavIds set in the Shell
  // will grey out everything they lack. This is safer than 500ing anywhere.
  redirect('/settings');
}
