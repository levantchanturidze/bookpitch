import { redirect } from 'next/navigation';

// Static redirect to /scheduler. Role-aware landing was tried in
// commit 6b941b2 but it forced a requireAuthContext() call on every
// home visit, doubling DB load and repeatedly exhausting Supabase's
// free-tier session-mode pool (15-client cap).
//
// Better fix pending: teach signInAction to pick the right landing
// from the JWT claims it already has, so no extra query is needed.
// Until then, ACCOUNTANT (and any role without booking.read) lands on
// /scheduler and gets the app/(app)/error.tsx "Access Locked" panel.
// See docs/rbac-findings.md F-10 + F-11.
export default function Root() {
  redirect('/scheduler');
}
