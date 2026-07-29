'use client';

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

const STATUS_STYLE: Record<string, string> = {
  active:    'bg-emerald-900 text-emerald-200',
  trial:     'bg-sky-900 text-sky-200',
  suspended: 'bg-red-900 text-red-200',
  archived:  'bg-slate-800 text-slate-500',
};

export default function OrgList({ orgs }: { orgs: OrgRow[] }) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Organizations — {orgs.length}</h2>
        <Link
          href="/platform/orgs/new"
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          + New organization
        </Link>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-800 bg-slate-950 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Vertical</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Plan</th>
              <th className="px-2 py-2 font-medium">Members</th>
              <th className="px-2 py-2 font-medium">Owner</th>
              <th className="px-2 py-2 font-medium">Impersonation</th>
              <th className="px-4 py-2 font-medium">Created</th>
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
                  <span className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[o.status] ?? 'bg-slate-800 text-slate-400'}`}>
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
                  {o.allowSupportImpersonation
                    ? <span className="text-emerald-300">enabled</span>
                    : <span className="text-slate-500">disabled</span>}
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
