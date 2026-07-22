import { requireRole } from '@/lib/auth';
import TabsNav from '@/components/settings/TabsNav';

export const metadata = { title: 'Settings · Bookpitch' };

// Owner-only wrapper for every /settings/* page. Middleware + role gate.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireRole('owner');
  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="font-mono text-[10px] tracking-widest text-slate-400 uppercase">
          Owner administration
        </p>
        <h2 className="mt-1 text-xl font-extrabold tracking-tight text-slate-900">Settings</h2>
        <p className="mt-1 text-xs text-slate-500">
          Locations, staff, services, and member access. Every mutation is written to the audit
          log.
        </p>
        <div className="mt-4">
          <TabsNav />
        </div>
      </header>

      {children}
    </div>
  );
}
