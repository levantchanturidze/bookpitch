import { redirect } from 'next/navigation';
import { requireAuthContext, requirePermission } from '@/lib/rbac';

// Bare /platform → send the caller to the orgs list.
// This page inherits the layout guard but re-runs the same check so a
// direct GET on /platform gets the redirect (Next won't call the layout
// for a redirect target on the same route group).
export default async function PlatformIndex() {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
  redirect('/platform/orgs');
}
