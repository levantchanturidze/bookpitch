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
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
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
  canEditToggles: boolean;
};

type Toggles = {
  providerFinancialReports: boolean;
  providerClinicalNotesOthers: boolean;
  frontdeskClientFullHistory: boolean;
  frontdeskDiscountCeiling: number;
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

export default function OrgDetail({
  org, capabilities, toggles,
}: {
  org: Org;
  capabilities: Capabilities;
  toggles: Toggles;
}) {
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

      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
          Billing
          <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-normal normal-case text-slate-400">
            read-only — managed in Stripe
          </span>
        </h3>
        <BillingPanel org={org} />
      </section>

      {capabilities.canEdit && (
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Edit</h3>
          <EditOrgForm org={org} onSaved={() => router.refresh()} onError={setError} freshAuth={freshAuth} />
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
          Feature toggles
          {!capabilities.canEditToggles && (
            <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-normal normal-case text-slate-400">
              view only — SUPER_ADMIN can edit
            </span>
          )}
        </h3>
        <OrgTogglesPanel
          orgId={org.id}
          initial={toggles}
          canEdit={capabilities.canEditToggles}
          onSaved={() => router.refresh()}
          onError={setError}
          freshAuth={freshAuth}
        />
      </section>


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

// F-08 read-only billing view. Surfaces the plan/planStatus/period-end
// columns and Stripe IDs so support can answer "what plan is this org
// on / when does it renew / where do I find them in Stripe" without a
// separate lookup. No write actions — subscription mutation stays in
// Stripe. Deep-links to the Stripe customer/subscription pages if IDs
// are present. Stripe env (test vs live) is not surfaced to the client,
// so the link uses the mode-agnostic dashboard URL that Stripe redirects
// appropriately.
function BillingPanel({ org }: { org: Org }) {
  const periodEnd = org.currentPeriodEnd ? new Date(org.currentPeriodEnd) : null;
  const daysToRenewal = periodEnd
    ? Math.floor((periodEnd.getTime() - Date.now()) / (24 * 3600_000))
    : null;
  const renewalTone =
    daysToRenewal === null   ? 'text-slate-500' :
    daysToRenewal < 0        ? 'text-red-300'   :
    daysToRenewal <= 7       ? 'text-amber-300'
                             : 'text-slate-300';
  const statusTone: Record<string, string> = {
    active:   'text-emerald-300',
    trialing: 'text-sky-300',
    past_due: 'text-amber-300',
    canceled: 'text-red-300',
    unpaid:   'text-red-300',
  };
  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4 md:grid-cols-2">
      <BillingRow label="Plan" value={<span className="font-mono uppercase">{org.plan}</span>} />
      <BillingRow
        label="Plan status"
        value={
          <span className={`font-mono uppercase ${statusTone[org.planStatus] ?? 'text-slate-300'}`}>
            {org.planStatus}
          </span>
        }
      />
      <BillingRow
        label="Current period ends"
        value={
          periodEnd ? (
            <span className="font-mono">
              <span className="text-slate-300">{periodEnd.toISOString().slice(0, 10)}</span>
              <span className={`ml-2 text-[10px] ${renewalTone}`}>
                ({daysToRenewal! < 0 ? `${-daysToRenewal!}d overdue` : `${daysToRenewal}d`})
              </span>
            </span>
          ) : <span className="font-mono text-slate-500">—</span>
        }
      />
      <BillingRow
        label="Stripe customer"
        value={
          org.stripeCustomerId ? (
            <a
              href={`https://dashboard.stripe.com/customers/${org.stripeCustomerId}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-sky-300 hover:underline"
            >
              {org.stripeCustomerId} ↗
            </a>
          ) : <span className="font-mono text-slate-500">not linked</span>
        }
      />
      <BillingRow
        label="Stripe subscription"
        value={
          org.stripeSubscriptionId ? (
            <a
              href={`https://dashboard.stripe.com/subscriptions/${org.stripeSubscriptionId}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-sky-300 hover:underline"
            >
              {org.stripeSubscriptionId} ↗
            </a>
          ) : <span className="font-mono text-slate-500">not linked</span>
        }
      />
    </div>
  );
}

function BillingRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <div className="mt-1 text-xs">{value}</div>
    </div>
  );
}

// F-08 feature-flags UI. Renders the four §6.2 ⚙️ toggle values for
// this org. SUPER_ADMIN gets edit controls (each PATCH requires reauth
// per the API); others see values only. Numeric field (discount ceiling)
// is separate from the three booleans.
function OrgTogglesPanel({
  orgId, initial, canEdit, onSaved, onError, freshAuth,
}: {
  orgId: string;
  initial: Toggles;
  canEdit: boolean;
  onSaved: () => void;
  onError: (msg: string | null) => void;
  freshAuth: () => Promise<boolean>;
}) {
  const [t, setT] = useState(initial);
  const [pending, setPending] = useState(false);

  const patch = async (delta: Partial<Toggles>) => {
    onError(null); setPending(true);
    try {
      if (canEdit) {
        const ok = await freshAuth();
        if (!ok) return;
      }
      const res = await fetch(`/api/platform/orgs/${orgId}/toggles`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(delta),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json() as { toggles: Toggles };
      setT(body.toggles);
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally { setPending(false); }
  };

  const rows: Array<{ key: keyof Toggles; label: string; hint: string }> = [
    { key: 'providerFinancialReports',
      label: 'Provider — org financial reports',
      hint: 'When on, PROVIDER can view org-level financial reports (default OFF).' },
    { key: 'providerClinicalNotesOthers',
      label: "Provider — others' clinical notes",
      hint: "When on, PROVIDER can read other clinicians' notes (default OFF)." },
    { key: 'frontdeskClientFullHistory',
      label: 'Front-desk — full client history',
      hint: 'When on, FRONT_DESK sees full client history (default OFF — contact only).' },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
      {rows.map(({ key, label, hint }) => {
        const val = t[key] as boolean;
        return (
          <div key={key} className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-200">{label}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
            </div>
            {canEdit ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => patch({ [key]: !val })}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
                  val ? 'border-emerald-600 text-emerald-200 hover:bg-emerald-950'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {val ? 'ON' : 'OFF'}
              </button>
            ) : (
              <span className={`font-mono text-xs ${val ? 'text-emerald-300' : 'text-slate-500'}`}>
                {val ? 'ON' : 'OFF'}
              </span>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-4 pt-2">
        <div>
          <p className="text-xs font-semibold text-slate-200">Front-desk discount ceiling</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Currency units. 0 = no discretionary discount for FRONT_DESK.
          </p>
        </div>
        {canEdit ? (
          <FrontdeskCeilingEditor
            value={t.frontdeskDiscountCeiling}
            pending={pending}
            onSave={(n) => patch({ frontdeskDiscountCeiling: n })}
          />
        ) : (
          <span className="font-mono text-xs text-slate-300">{t.frontdeskDiscountCeiling}</span>
        )}
      </div>
    </div>
  );
}

function FrontdeskCeilingEditor({
  value, pending, onSave,
}: { value: number; pending: boolean; onSave: (n: number) => void }) {
  const [n, setN] = useState(String(value));
  const dirty = String(value) !== n && Number.isFinite(Number(n)) && Number(n) >= 0;
  return (
    <div className="flex items-center gap-2">
      <input
        type="number" min="0" step="1"
        value={n}
        onChange={(e) => setN(e.target.value)}
        className="w-24 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
      />
      <button
        type="button" disabled={pending || !dirty}
        onClick={() => onSave(Number(n))}
        className="rounded-md border border-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
      >
        Save
      </button>
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
