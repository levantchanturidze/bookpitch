import { createHash, randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { UserRole } from '@prisma/client';
import { withOrg, withoutRls } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { getEmailProvider } from '@/lib/messaging';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { buildAuthContext, canManageRoleAssignment } from '@/lib/rbac';

// Legacy enum → Phase 3 role key. Kept here (small mapping duplicated
// with lib/admin.ts) so this module stays self-contained.
const ENUM_TO_KEY: Record<UserRole, string> = {
  owner: 'ORG_OWNER',
  practitioner: 'PROVIDER',
  receptionist: 'FRONT_DESK',
};

// -----------------------------------------------------------------------------
// Staff invitations.
//
// createInvitation(session, {email, role}) — owner-only:
//   - Rejects if a pending invite already exists for the email in this org.
//   - Stores a sha256 hash of the raw token, 72h expiry.
//   - Emails the raw acceptance URL.
//   - Returns the invitation id + the raw URL so the UI can offer a
//     copy-to-clipboard fallback if email delivery is slow.
//
// acceptInvitation({token, password?, fullName?}) — public:
//   - Hashes the token, looks it up, checks status + expiry.
//   - If an AppUser already exists for the invitee email, just links a new
//     Membership (password is ignored).
//   - Otherwise creates the AppUser with argon2 password + Membership.
//   - Marks the invitation accepted so replays fail.
// -----------------------------------------------------------------------------

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export type CreateInvitationInput = { email: string; role: UserRole };
export type CreateInvitationResult = { id: string; url: string };

export async function createInvitation(
  session: ActiveSession,
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  // Route-level guard already checked `staff.invite`. Phase 6 adds a
  // second layer here: the invited ROLE must be one the actor can
  // assign per the rank + lattice (spec §9 rule 2). An ORG_ADMIN
  // cannot invite an ORG_OWNER via this flow; enforcement of the same
  // rule on updateMemberRole prevents the same escalation post-accept.
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new InvalidInputError('email is invalid');
  const role = input.role;
  if (role !== 'owner' && role !== 'practitioner' && role !== 'receptionist') {
    throw new InvalidInputError('role must be owner | practitioner | receptionist');
  }
  const targetKey = ENUM_TO_KEY[role];
  if (session.membershipId) {
    const actorCtx = await buildAuthContext(session.userId, session.membershipId);
    if (!actorCtx) throw new InvalidInputError('actor has no active membership');
    const canManage = await canManageRoleAssignment(actorCtx, targetKey);
    if (!canManage) {
      throw new InvalidInputError(`your role cannot invite the ${targetKey} role`);
    }
  }

  const raw = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(raw);

  const inv = await withOrg(session.organizationId, async (tx) => {
    const existing = await tx.invitation.findFirst({
      where: { email, status: 'pending' },
    });
    if (existing) throw new InvalidInputError('an invitation is already pending for this email');
    return tx.invitation.create({
      data: {
        organizationId: session.organizationId,
        email,
        role,
        tokenHash,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        invitedBy: session.userId,
      },
    });
  });

  const origin = process.env.APP_URL ?? 'http://localhost:3000';
  const url = `${origin}/invite?token=${encodeURIComponent(raw)}`;
  try {
    const provider = getEmailProvider();
    await provider.send(
      email,
      'You are invited to Bookpitch',
      `You've been invited to join a Bookpitch workspace as ${role}.\n\nAccept within 72 hours:\n\n${url}`,
    );
  } catch (err) {
    log.warn('invitation.email_failed', { error: sanitizeErrorMessage(err) });
  }
  return { id: inv.id, url };
}

export type AcceptInvitationInput = {
  token: string;
  password?: string;
  fullName?: string;
};
export type AcceptInvitationResult = {
  userId: string;
  organizationId: string;
  role: UserRole;
};

export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  const { token } = input;
  if (typeof token !== 'string' || token.length < 20) {
    throw new InvalidInputError('token is required');
  }
  const tokenHash = hashToken(token);

  // Read the invitation without a session (there IS no session — the user
  // may not exist yet). Bypasses RLS via withoutRls.
  const invite = await withoutRls((tx) => tx.invitation.findUnique({ where: { tokenHash } }));
  if (!invite) throw new InvalidInputError('invalid or expired invitation');
  if (invite.status !== 'pending') {
    throw new InvalidInputError('invitation is no longer pending');
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    await withoutRls((tx) =>
      tx.invitation.update({ where: { id: invite.id }, data: { status: 'expired' } }),
    );
    throw new InvalidInputError('invalid or expired invitation');
  }

  return withoutRls(async (tx) => {
    const existing = await tx.appUser.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });
    let userId: string;
    if (existing) {
      // Existing account joins the new org. Password field is ignored — they
      // already have credentials.
      userId = existing.id;
    } else {
      const password = input.password ?? '';
      if (password.length < 8) {
        throw new InvalidInputError('password must be at least 8 characters');
      }
      const fullName = (input.fullName ?? '').trim() || invite.email.split('@')[0];
      const passwordHash = await hash(password);
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: invite.email,
          email: invite.email,
          fullName,
          passwordHash,
        },
      });
      userId = user.id;
    }

    // Idempotent — if they already have a membership in this org (e.g.
    // re-accept from a second tab), just return.
    await tx.membership.upsert({
      where: {
        organizationId_userId: { organizationId: invite.organizationId, userId },
      },
      create: { organizationId: invite.organizationId, userId, role: invite.role },
      update: {},
    });
    // Owner invitations wire the org pointer so spec §9 rule 1 is satisfied
    // immediately after acceptance — org operations blocked by assertOrgOwnerSet
    // (updateMemberRole, removeMember, billing) become available right away.
    if (invite.role === 'owner') {
      await tx.organization.update({
        where: { id: invite.organizationId },
        data: { ownerUserId: userId },
      });
    }
    await tx.invitation.update({
      where: { id: invite.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    });

    log.info('invitation.accepted', {
      organizationId: invite.organizationId,
      userId,
      role: invite.role,
    });
    return { userId, organizationId: invite.organizationId, role: invite.role };
  });
}

export async function revokeInvitation(session: ActiveSession, id: string): Promise<void> {
  // Authorization enforced by caller via requirePermission(ctx, 'staff.invite').
  await withOrg(session.organizationId, (tx) =>
    tx.invitation.update({
      where: { id },
      data: { status: 'revoked' },
    }),
  );
}
