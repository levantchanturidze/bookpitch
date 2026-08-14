'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

const NAV = [
  { href: '/platform/orgs', label: 'Organizations' },
  { href: '/platform/roles', label: 'Platform roles' },
  { href: '/platform/audit', label: 'Audit log' },
  { href: '/platform/break-glass', label: 'Break-glass' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function PlatformShell({
  children,
  email,
  breakGlassActive,
  breakGlassExpiresAt,
  impersonationActive,
}: {
  children: React.ReactNode;
  email: string;
  breakGlassActive: boolean;
  breakGlassExpiresAt: string | null;
  impersonationActive: boolean;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Break-glass banner — spec §7.2 rule 5. Persistent, red, dismiss-proof. */}
      {breakGlassActive && (
        <div className="sticky top-0 z-50 border-b-2 border-red-500 bg-red-950/90 px-4 py-2 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3">
            <ShieldAlert className="h-4 w-4 text-red-300" />
            <p className="text-xs font-bold tracking-wide text-red-100 uppercase">
              Break-glass session active
              {breakGlassExpiresAt && (
                <span className="ml-2 font-mono tracking-normal text-red-200 normal-case">
                  · expires{' '}
                  {new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
                    new Date(breakGlassExpiresAt),
                  )}
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/platform/break-glass/end', { method: 'POST' });
                window.location.reload();
              }}
              className="ml-auto rounded-md border border-red-400 px-2 py-1 text-[10px] font-semibold text-red-100 hover:bg-red-900"
            >
              End session
            </button>
          </div>
        </div>
      )}
      {/* Impersonation banner — spec §7.1 rule 4. Yellow so it's distinct
          from break-glass. */}
      {impersonationActive && (
        <div className="sticky top-0 z-50 border-b border-amber-500 bg-amber-900/80 px-4 py-2">
          <div className="mx-auto flex max-w-7xl items-center gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-300" />
            <p className="text-xs font-bold tracking-wide text-amber-100 uppercase">
              Impersonation session active
            </p>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/platform/impersonate/end', { method: 'POST' });
                window.location.reload();
              }}
              className="ml-auto rounded-md border border-amber-400 px-2 py-1 text-[10px] font-semibold text-amber-100 hover:bg-amber-900"
            >
              End
            </button>
          </div>
        </div>
      )}

      <header className="border-b border-slate-800 bg-slate-900 px-6 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-slate-500 uppercase">
              Bookpitch Platform
            </p>
            <h1 className="font-display text-sm font-extrabold tracking-tight">Operator console</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono">{email}</span>
            <Link
              href="/"
              className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
            >
              ← Back to app
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 p-6">
        <aside className="col-span-3">
          <nav className="space-y-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive(pathname, n.href)
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="col-span-9 space-y-6">{children}</main>
      </div>
    </div>
  );
}
