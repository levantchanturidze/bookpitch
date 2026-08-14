'use client';

import { AlertTriangle, ShieldAlert } from 'lucide-react';

/**
 * Persistent banner shown inside the org-plane Shell when the current
 * caller is either impersonating (spec §7.1 rule 4) or in a break-glass
 * session (spec §7.2 rule 5). Rendered inside the top-of-page area so
 * it's unmissable without being intrusive.
 */
export default function PlatformSessionBanner({
  impersonation,
  breakGlass,
}: {
  impersonation: { expiresAt: string } | null;
  breakGlass: { expiresAt: string } | null;
}) {
  if (breakGlass) {
    return (
      <div className="border-b-2 border-red-500 bg-red-950/95 px-4 py-2 text-red-100">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <p className="text-xs font-bold tracking-wide uppercase">
            Break-glass session active — every read is audited
            <span className="ml-2 font-mono tracking-normal text-red-200 normal-case">
              · expires{' '}
              {new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
                new Date(breakGlass.expiresAt),
              )}
            </span>
          </p>
        </div>
      </div>
    );
  }
  if (impersonation) {
    return (
      <div className="border-b border-amber-500 bg-amber-900/90 px-4 py-2 text-amber-100">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="text-xs font-bold tracking-wide uppercase">
            Impersonation session — you are viewing this org on behalf of another user
            <span className="ml-2 font-mono tracking-normal text-amber-200 normal-case">
              · expires{' '}
              {new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
                new Date(impersonation.expiresAt),
              )}
            </span>
          </p>
        </div>
      </div>
    );
  }
  return null;
}
