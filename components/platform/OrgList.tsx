'use client';

import { useMemo } from 'react';
import Link from 'next/link';

type OrgRow = {
  id: string;
  name: string;
  vertical: string | null;
  status: string;
  plan: string;
  planStatus: string;
  memberCount: number;
  ownerEmail: string | null;
  allowSupportImpersonation: boolean;
  createdAt: string;
};

// F-08 org-status aggregate dashboard. All computed in-memory from the
// already-loaded org list — no extra queries. Meant as a fast support-
// triage snapshot at the top of /platform/orgs. Grows to a real
// dedicated dashboard as soon as we outgrow "sum a list".
function StatusSummary({ orgs }: { orgs: OrgRow[] }) {
  const s = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byPlan: Record<string, number> = {};
    let members = 0;
    let missingOwner = 0;
    let recentSignups = 0;
    let impersonationEnabled = 0;
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 3600_000;
    for (const o of orgs) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      byPlan[o.plan] = (byPlan[o.plan] ?? 0) + 1;
      members += o.memberCount;
      if (!o.ownerEmail) missingOwner += 1;
      if (new Date(o.createdAt).getTime() >= sevenDaysAgo) recentSignups += 1;
      if (o.allowSupportImpersonation) impersonationEnabled += 1;
    }
    return { byStatus, byPlan, members, missingOwner, recentSignups, impersonationEnabled };
  }, [orgs]);

  const statusOrder: Array<keyof typeof s.byStatus> = ['active', 'trial', 'suspended', 'archived'];
  const statusColor: Record<string, string> = {
    active: 'text-emerald-300',
    trial: 'text-sky-300',
    suspended: 'text-red-300',
    archived: 'text-slate-500',
  };

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
      <SummaryCard label="Organizations" value={orgs.length} tone="strong" />
      <SummaryCard
        label="By status"
        value={
          <div className="flex flex-wrap gap-1 font-mono text-[10px]">
            {statusOrder
              .filter((k) => s.byStatus[k])
              .map((k) => (
                <span key={k} className={statusColor[k]}>
                  {k}: {s.byStatus[k]}
                </span>
              ))}
          </div>
        }
      />
      <SummaryCard label="Members (all)" value={s.members} />
      <SummaryCard
        label="Missing owner"
        value={s.missingOwner}
        tone={s.missingOwner > 0 ? 'warn' : 'default'}
      />
      <SummaryCard label="New in 7 days" value={s.recentSignups} />
      <SummaryCard
        label="Support access on"
        value={s.impersonationEnabled}
        hint={`of ${orgs.length}`}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'strong' | 'warn';
}) {
  const border =
    tone === 'warn'
      ? 'border-amber-800 bg-amber-950'
      : tone === 'strong'
        ? 'border-slate-700 bg-slate-800'
        : 'border-slate-800 bg-slate-900';
  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <p className="font-mono text-[10px] tracking-wider text-slate-500 uppercase">{label}</p>
      <div className="mt-1 font-mono text-lg font-bold text-slate-100">{value}</div>
      {hint && <p className="mt-0.5 text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-900 text-emerald-200',
  trial: 'bg-sky-900 text-sky-200',
  suspended: 'bg-red-900 text-red-200',
  archived: 'bg-slate-800 text-slate-500',
};

export default function OrgList({ orgs }: { orgs: OrgRow[] }) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Organizations</h2>
        <Link
          href="/platform/orgs/new"
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          + New organization
        </Link>
      </div>
      <StatusSummary orgs={orgs} />
      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-800 bg-slate-950 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Vertical
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Plan
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Members
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Owner
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Impersonation
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {orgs.map((o) => (
              <tr key={o.id} className="hover:bg-slate-800/40">
                <td className="px-4 py-2 font-medium">
                  <Link href={`/platform/orgs/${o.id}`} className="text-sky-300 hover:underline">
                    {o.name}
                  </Link>
                </td>
                <td className="px-2 py-2 text-slate-400">{o.vertical ?? '—'}</td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[o.status] ?? 'bg-slate-800 text-slate-400'}`}
                  >
                    {o.status}
                  </span>
                </td>
                <td className="px-2 py-2 font-mono text-slate-300">
                  {o.plan}
                  <span className="ml-1 text-[10px] text-slate-500">({o.planStatus})</span>
                </td>
                <td className="px-2 py-2 text-right font-mono text-slate-300">{o.memberCount}</td>
                <td className="px-2 py-2 font-mono text-[10px] text-slate-400">
                  {o.ownerEmail ?? '—'}
                </td>
                <td className="px-2 py-2 text-[10px]">
                  {o.allowSupportImpersonation ? (
                    <span className="text-emerald-300">enabled</span>
                  ) : (
                    <span className="text-slate-500">disabled</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-[10px] text-slate-500">
                  {o.createdAt.slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
