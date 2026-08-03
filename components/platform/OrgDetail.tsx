'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type Org = {
  id: string;
  name: string;
  status: string;
  plan: string;
  planStatus: string;
  vertical: string | null;
  allowSupportImpersonation: boolean;
  owner: { id: string; email: string; fullName: string | null } | null;
  counts: { memberships: number; locations: number; branches: number; customers: number; appointments: number };
  members: Array<{ id: string; userId: string; email: string; fullName: string | null; roleKey: string }>;
};

type Capabilities = {
  canSuspend: boolean;
  canDelete: boolean;
  canChangeOwner: boolean;
  canResetPassword: boolean;
  canImpersonate: boolean;
  canEdit: boolean;
};

/**
 * Prompt for password + POST /api/platform/reauth. Returns true on
 * success, throws otherwise (bubble up to the caller's catch).
 */
async function freshAuth(): Promise<boolean> {
  const password = window.prompt('Confirm your password to continue:');
  if (!password) return false;
  const res = await fetch('/api/platform/reauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error('password verification failed');
  return true;
}

export default function OrgDetail({ org, capabilities }: { org: Org; capabilities: Capabilities }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const suspend = () => {
    const reason = window.prompt('Reason for suspending this org (min 5 chars):');
    if (!reason || reason.length < 5) return;
    startTransition(async () => {
      try {
        if (!(await freshAuth())) return;
        const res = await fetch(`/api/platform/orgs/${org.id}/suspend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) throw new Error(await res.text());
        router.refresh();
      } catch (err) { setError((err as Error).message); }
    });
  };

  const reactivate = () => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/platform/orgs/${org.id}/reactivate`, { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        router.refresh();
      } catch (err) { setError((err as Error).message); }
    });
  };

  const softDelete = () => {
    const reason = window.prompt('Reason for archiving this org (min 5 chars). 30-day grace:');
    if (!reason || reason.length < 5) return;
    if (!window.confirm(`Archive ${org.name}? Members lose access immediately.`)) return;
    startTransition(async () => {
      try {
        if (!(await freshAuth())) return;
        const res = await fetch(`/api/platform/orgs/${org.id}/soft-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) throw new Error(await res.text());
        router.refresh();
      } catch (err) { setError((err as Error).message); }
    });
  };

  const sendResetLink = () => {
    const email = window.prompt('Email of the member to reset:');
    if (!email) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/platform/orgs/${org.id}/reset-password-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) throw new Error(await res.text());
        alert(`Reset link sent to ${email} (silent success if not a member).`);
      } catch (err) { setError((err as Error).message); }
    });
  };

  const impersonate = (targetUserId: string, targetEmail: string) => {
    if (!org.allowSupportImpersonation) {
      alert('This org has disabled support impersonation. Enable it in the org settings first (or use break-glass).');
      return;
    }
    const reason = window.prompt(`Reason for impersonating ${targetEmail} (min 5 chars):`);
    if (!reason || reason.length < 5) return;
    const ticketId = window.prompt('Ticket ID:');
    if (!ticketId) return;
    startTransition(async () => {
      try {
        const res = await fetch('/api/platform/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            organizationId: org.id,
            targetUserId,
            reason,
            ticketId,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        alert('Impersonation started. You may now navigate into the org — the target will see a banner.');
        router.refresh();
      } catch (err) { setError((err as Error).message); }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/platform/orgs" className="text-xs text-slate-400 hover:underline">
          ← All organizations
        </Link>
        <h2 className="mt-1 text-lg font-bold">{org.name}</h2>
        <p className="mt-1 font-mono text-xs text-slate-500">
          {org.id} · {org.vertical ?? 'no vertical'} · {org.status} · plan {org.plan} ({org.planStatus})
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-slate-800 bg-slate-900 p-4 text-xs md:grid-cols-4">
        <Stat label="members" value={org.counts.memberships} />
        <Stat label="branches" value={org.counts.branches} />
        <Stat label="customers" value={org.counts.customers} />
        <Stat label="appointments" value={org.counts.appointments} />
      </div>

      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Actions</h3>
        <div className="flex flex-wrap gap-2">
          {capabilities.canSuspend && org.status === 'active' && (
            <Btn label="Suspend org" onClick={suspend} pending={pending} />
          )}
          {capabilities.canSuspend && org.status === 'suspended' && (
            <Btn label="Reactivate org" onClick={reactivate} pending={pending} kind="ok" />
          )}
          {capabilities.canDelete && org.status !== 'archived' && (
            <Btn label="Archive (soft-delete)" onClick={softDelete} pending={pending} kind="danger" />
          )}
          {capabilities.canResetPassword && (
            <Btn label="Send password-reset link" onClick={sendResetLink} pending={pending} />
          )}
        </div>
      </section>

      {capabilities.canEdit && (
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Edit</h3>
          <EditOrgForm org={org} onSaved={() => router.refresh()} onError={setError} freshAuth={freshAuth} />
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Members</h3>
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 bg-slate-950 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {org.members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 font-mono">{m.email}</td>
                  <td className="px-2 py-2 font-mono text-slate-400">{m.roleKey}</td>
                  <td className="px-4 py-2 text-right">
                    {capabilities.canImpersonate && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => impersonate(m.userId, m.email)}
                        className="rounded border border-amber-600 px-2 py-1 text-[10px] font-medium text-amber-200 hover:bg-amber-950 disabled:opacity-40"
                      >
                        Impersonate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-bold">{value}</p>
    </div>
  );
}

// F-08 edit-org UI. Two shapes:
//   • name + vertical: plain PATCH, no reauth
//   • allowSupportImpersonation: separate toggle, requires reauth
//     (destructive-tier — changing support-access policy)
function EditOrgForm({
  org, onSaved, onError, freshAuth,
}: {
  org: Org;
  onSaved: () => void;
  onError: (err: string | null) => void;
  freshAuth: () => Promise<boolean>;
}) {
  const [name, setName] = useState(org.name);
  const [vertical, setVertical] = useState<string>(org.vertical ?? '');
  const [pending, setPending] = useState(false);
  const [supportAllowed, setSupportAllowed] = useState(org.allowSupportImpersonation);

  const saveFields = async () => {
    onError(null);
    const patch: Record<string, unknown> = {};
    if (name.trim() !== org.name) patch.name = name.trim();
    const nextVertical = vertical || null;
    if (nextVertical !== org.vertical) patch.vertical = nextVertical;
    if (Object.keys(patch).length === 0) return;
    setPending(true);
    try {
      const res = await fetch(`/api/platform/orgs/${org.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally { setPending(false); }
  };

  const toggleSupport = async () => {
    onError(null);
    setPending(true);
    try {
      const ok = await freshAuth();
      if (!ok) return;
      const res = await fetch(`/api/platform/orgs/${org.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowSupportImpersonation: !supportAllowed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSupportAllowed(!supportAllowed);
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally { setPending(false); }
  };

  return (
    <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Vertical
          </span>
          <select
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">(unset)</option>
            <option value="clinic">Clinic</option>
            <option value="salon">Salon</option>
            <option value="fitness">Fitness</option>
            <option value="mixed">Mixed</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={pending || (name.trim() === org.name && (vertical || null) === org.vertical)}
        onClick={saveFields}
        className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
      >
        Save name / vertical
      </button>

      <hr className="border-slate-800" />

      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-200">Support impersonation</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            When enabled, PLATFORM_ADMIN can impersonate an org member for support.
            Some verticals (clinical) contractually require this to stay OFF.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={toggleSupport}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
            supportAllowed
              ? 'border-emerald-600 text-emerald-200 hover:bg-emerald-950'
              : 'border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          {supportAllowed ? 'Disable (reauth)' : 'Enable (reauth)'}
        </button>
      </div>
    </div>
  );
}

function Btn({
  label, onClick, pending, kind = 'default',
}: { label: string; onClick: () => void; pending: boolean; kind?: 'default' | 'danger' | 'ok' }) {
  const cls =
    kind === 'danger' ? 'border-red-600 text-red-200 hover:bg-red-950' :
    kind === 'ok'     ? 'border-emerald-600 text-emerald-200 hover:bg-emerald-950' :
                        'border-slate-700 text-slate-200 hover:bg-slate-800';
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${cls}`}
    >
      {label}
    </button>
  );
}
