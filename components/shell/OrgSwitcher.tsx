'use client';

import { useEffect, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';

type Membership = {
  organizationId: string;
  organizationName: string;
  role: 'owner' | 'practitioner' | 'receptionist';
};

// Compact dropdown next to the org name. Only appears when the user has
// >1 memberships — single-org users don't need clutter. Fetches lazily on
// open to keep initial paint cheap.
export default function OrgSwitcher({
  activeName,
  activeOrganizationId,
}: {
  activeName: string;
  activeOrganizationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Membership[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    fetch('/api/session/memberships')
      .then((r) => r.json())
      .then((j: { memberships?: Membership[] }) => setRows(j.memberships ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  async function switchTo(orgId: string) {
    if (orgId === activeOrganizationId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const res = await fetch('/api/session/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: orgId }),
    });
    setBusy(false);
    if (res.ok) window.location.reload();
  }

  // Hide entirely when we know there's only one membership.
  if (rows !== null && rows.length <= 1) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hidden items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 sm:inline-flex"
        aria-label="Switch organization"
      >
        <Building2 className="h-3 w-3" />
        {activeName}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && rows && (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          <p className="px-2 py-1.5 text-[10px] font-bold tracking-widest text-slate-400 uppercase">
            Your organisations
          </p>
          {rows.map((m) => (
            <button
              key={m.organizationId}
              type="button"
              disabled={busy}
              onClick={() => switchTo(m.organizationId)}
              className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              <span>
                <span className="block font-semibold">{m.organizationName}</span>
                <span className="text-[10px] uppercase text-slate-400">{m.role}</span>
              </span>
              {m.organizationId === activeOrganizationId && (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
