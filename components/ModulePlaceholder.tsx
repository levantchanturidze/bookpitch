import type { LucideIcon } from 'lucide-react';
import type { UserRole } from '@prisma/client';
import type { ActiveLocation } from '@/lib/active-location';

type Props = {
  title: string;
  incoming: string;
  icon: LucideIcon;
  session: { email: string; role: UserRole };
  activeLocation: ActiveLocation;
};

export default function ModulePlaceholder({
  title,
  incoming,
  icon: Icon,
  session,
  activeLocation,
}: Props) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-slate-100 p-3 text-slate-500">
          <Icon className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Layout wired. The real module lands in <span className="font-mono">{incoming}</span>.
          </p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-3 border-t border-slate-100 pt-6 text-xs sm:grid-cols-3">
        <div>
          <dt className="font-mono tracking-wider text-slate-400 uppercase">Signed in as</dt>
          <dd className="mt-1 font-semibold text-slate-700">{session.email}</dd>
          <dd className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-400 uppercase">
            {session.role}
          </dd>
        </div>
        <div>
          <dt className="font-mono tracking-wider text-slate-400 uppercase">Active location</dt>
          <dd className="mt-1 font-semibold text-slate-700">{activeLocation.name}</dd>
          <dd className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-400 uppercase">
            {activeLocation.type}
          </dd>
        </div>
        <div>
          <dt className="font-mono tracking-wider text-slate-400 uppercase">Status</dt>
          <dd className="mt-1 font-semibold text-emerald-700">Server guard passed</dd>
          <dd className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-400 uppercase">
            requireRole()
          </dd>
        </div>
      </dl>
    </div>
  );
}
