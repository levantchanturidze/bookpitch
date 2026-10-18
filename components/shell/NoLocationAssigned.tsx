import { MapPinOff } from 'lucide-react';

/**
 * Shown by a location-centric page when the caller reaches no location at all —
 * a branch-scoped member whose branch set is empty (an empty set means no
 * reach: lib/rbac/can.ts 4b). Their module permission is intact, so the 403
 * boundary's "your role is restricted" would be wrong; what is missing is an
 * assignment, and only an owner or administrator can make one.
 */
export default function NoLocationAssigned() {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center space-y-3 rounded-2xl border border-slate-200 bg-white p-12 text-center"
    >
      <div className="rounded-full bg-slate-100 p-4 text-slate-600">
        <MapPinOff className="h-7 w-7" aria-hidden="true" />
      </div>
      <h2 className="text-base font-extrabold text-slate-800">No location assigned</h2>
      <p className="mx-auto max-w-sm text-xs leading-relaxed text-slate-600">
        Your account is not assigned to any location yet. An owner or administrator can assign one
        under Settings → Members.
      </p>
    </div>
  );
}
