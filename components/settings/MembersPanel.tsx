'use client';

import { useState, useTransition } from 'react';
import type { UserRole } from '@prisma/client';
import { Link2, Plus, Trash2 } from 'lucide-react';
import {
  inviteMemberAction,
  removeMemberAction,
  updateMemberRoleAction,
} from './actions';

export type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  createdAt: string;
};

const ROLES: UserRole[] = ['owner', 'practitioner', 'receptionist'];

export default function MembersPanel({
  members,
  currentUserId,
}: {
  members: MemberRow[];
  currentUserId: string;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Phase 4: admins send invitation LINKS, never passwords. Show the URL
  // so the sender can copy-paste in case email delivery fails / isn't set up.
  const [inviteUrl, setInviteUrl] = useState<{ email: string; url: string } | null>(null);

  const invite = (input: { email: string; role: UserRole }) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await inviteMemberAction(input);
        setInviteUrl({ email: input.email, url: result.url });
        setAdding(false);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const changeRole = (membershipId: string, role: UserRole) => {
    setError(null);
    startTransition(async () => {
      try {
        await updateMemberRoleAction(membershipId, role);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const remove = (membershipId: string, email: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await removeMemberAction(membershipId);
      } catch (err) {
        setError((err as Error).message);
      }
    });
    void email;
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">Members — {members.length}</h3>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" /> Invite member
        </button>
      </div>
      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}
      {inviteUrl && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-900">
          <div className="flex items-start gap-2">
            <Link2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p className="font-bold">Invitation sent to <span className="font-mono">{inviteUrl.email}</span></p>
              <p className="mt-1">
                They&apos;ll receive an email with a link to accept. If email delivery is
                delayed, copy the link below and send it out-of-band:
              </p>
              <p className="mt-2 rounded-lg bg-white px-3 py-2 font-mono text-[11px] break-all text-slate-900">
                {inviteUrl.url}
              </p>
            </div>
            <button
              onClick={() => setInviteUrl(null)}
              className="text-[10px] text-emerald-700 hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th className="px-6 py-2 font-medium">Email</th>
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Role</th>
              <th className="px-2 py-2 font-medium">Joined</th>
              <th className="px-6 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((m) => {
              const isSelf = m.userId === currentUserId;
              return (
                <tr key={m.membershipId} className={isSelf ? 'bg-slate-50/40' : ''}>
                  <td className="px-6 py-2 font-mono text-[11px] text-slate-700">
                    {m.email}
                    {isSelf && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
                        you
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-slate-600">{m.fullName ?? '—'}</td>
                  <td className="px-2 py-2">
                    <select
                      value={m.role}
                      disabled={isSelf || isPending}
                      onChange={(e) => changeRole(m.membershipId, e.target.value as UserRole)}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 font-mono text-[10px] text-slate-500">
                    {m.createdAt.slice(0, 10)}
                  </td>
                  <td className="px-6 py-2 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${m.email} from this org?`)) {
                          remove(m.membershipId, m.email);
                        }
                      }}
                      disabled={isSelf || isPending}
                      className="rounded-md border border-rose-200 p-1.5 text-rose-500 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                      title={isSelf ? 'Cannot remove yourself' : 'Remove member'}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {adding && (
        <InviteForm
          isPending={isPending}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
          onSubmit={invite}
        />
      )}
    </section>
  );
}

function InviteForm({
  isPending,
  onCancel,
  onSubmit,
}: {
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (v: { email: string; role: UserRole }) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('receptionist');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ email, role });
      }}
      className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-4"
    >
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Email
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
        Role
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal text-slate-800"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end justify-end gap-2 md:col-span-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
        >
          {isPending ? 'Sending…' : 'Send invitation link'}
        </button>
      </div>
    </form>
  );
}
