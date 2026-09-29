import type { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, InvalidInputError, NotFoundError, type ActiveSession } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { buildAuthContext, canManageRoleAssignment } from '@/lib/rbac';
import type { AuthContext } from '@/lib/rbac';

// -----------------------------------------------------------------------------
// Scoped access administration (C7): the two facts that decide what a member
// can reach inside their organisation, beyond their role.
//
//   staff ↔ member link   Staff.userId. A PROVIDER owns (`:own`) exactly the
//                         appointments and schedules of the staff rows linked
//                         to their account. Nothing wrote this column before.
//
//   membership branches   membership_branches. A `:branch` member (FRONT_DESK)
//                         reaches exactly these branches; an EMPTY set reaches
//                         nothing. Nothing wrote this table before either.
//
// Both change what a member can reach, which is the same authority as changing
// their role — so both sit behind the same gate as updateMemberRole:
// `staff.role.assign`, plus the rank/lattice check against the TARGET member's
// role (CLAUDE.md invariant 4: nobody modifies a member at or above their own
// rank), and never on yourself. Every change is audited with the real entity
// and id, and a branch change bumps the member's sessionVersion (spec §9 rule
// 10) so it takes effect on their next request rather than after a cache TTL.
//
// Cardinality (docs/scoped-rbac-assumption-audit.md §2): one linked staff row
// per (location, user), enforced by staff_location_user_unique. A practitioner
// at two locations has two linked rows. The database also refuses a link to a
// user with no membership in the staff row's organisation, and a branch scope
// outside the membership's organisation (20260929000001).
// -----------------------------------------------------------------------------

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    throw new InvalidInputError(`${field} must be a uuid`);
  }
  return v;
}

async function actorContext(session: ActiveSession): Promise<AuthContext> {
  // Resolved outside any withOrg tx, exactly as updateMemberRole does, so it
  // does not fight the tenant-locked connection.
  const ctx = session.membershipId
    ? await buildAuthContext(session.userId, session.membershipId)
    : null;
  if (!ctx) throw new InvalidInputError('actor has no active membership in this org');
  return ctx;
}

async function assertCanModifyMember(
  actorCtx: AuthContext,
  session: ActiveSession,
  target: { userId: string; roleKey: string | null },
  what: string,
): Promise<void> {
  if (target.userId === session.userId) {
    throw new InvalidInputError(`you cannot change your own ${what}`);
  }
  if (!target.roleKey || !(await canManageRoleAssignment(actorCtx, target.roleKey))) {
    throw new InvalidInputError(
      `your role cannot change the ${what} of a ${target.roleKey ?? 'member without a role'}`,
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

// -----------------------------------------------------------------------------
// Staff ↔ member link
// -----------------------------------------------------------------------------

export type StaffLinkResult = { staffId: string; userId: string | null; changed: boolean };

/**
 * Link a staff row to a member's account. Idempotent when it is already linked
 * to that member; refuses to silently take over a row linked to someone else.
 */
export async function linkStaffToMember(
  session: ActiveSession,
  staffIdInput: unknown,
  userIdInput: unknown,
): Promise<StaffLinkResult> {
  const staffId = requireUuid(staffIdInput, 'staffId');
  const userId = requireUuid(userIdInput, 'userId');
  const actorCtx = await actorContext(session);

  return withOrg(session.organizationId, async (tx) => {
    // RLS: a staff row in another organisation is invisible — not found.
    const staff = await tx.staff.findUnique({
      where: { id: staffId },
      select: { id: true, userId: true },
    });
    if (!staff) throw new NotFoundError('staff not found');

    const member = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: session.organizationId, userId } },
      select: { id: true, status: true, roleRef: { select: { key: true } } },
    });
    if (!member || member.status !== 'active') {
      throw new InvalidInputError('that user is not an active member of this organisation');
    }
    await assertCanModifyMember(
      actorCtx,
      session,
      { userId, roleKey: member.roleRef?.key ?? null },
      'staff link',
    );

    if (staff.userId === userId) return { staffId, userId, changed: false };
    if (staff.userId !== null) {
      throw new ConflictError(
        'this staff record is already linked to another member — unlink it first',
      );
    }

    try {
      // Conditional on the row still being unlinked, so two concurrent links
      // cannot both succeed and the second silently replace the first.
      const updated = await tx.staff.updateMany({
        where: { id: staffId, userId: null },
        data: { userId },
      });
      if (updated.count !== 1) {
        throw new ConflictError('this staff record was linked concurrently — reload and try again');
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          'that member is already linked to another staff record at this location',
        );
      }
      throw err;
    }

    await writeAudit(tx, session, 'update', 'staff', staffId, {
      link: { userId, membershipId: member.id },
    });
    return { staffId, userId, changed: true };
  });
}

/** Remove a staff row's link. Idempotent when it is not linked. */
export async function unlinkStaff(
  session: ActiveSession,
  staffIdInput: unknown,
): Promise<StaffLinkResult> {
  const staffId = requireUuid(staffIdInput, 'staffId');
  const actorCtx = await actorContext(session);

  return withOrg(session.organizationId, async (tx) => {
    const staff = await tx.staff.findUnique({
      where: { id: staffId },
      select: { id: true, userId: true },
    });
    if (!staff) throw new NotFoundError('staff not found');
    if (staff.userId === null) return { staffId, userId: null, changed: false };

    // The linked member may since have left the organisation; then there is no
    // role to outrank and the stale link may simply be cleared.
    const member = await tx.membership.findUnique({
      where: {
        organizationId_userId: { organizationId: session.organizationId, userId: staff.userId },
      },
      select: { roleRef: { select: { key: true } } },
    });
    if (member) {
      await assertCanModifyMember(
        actorCtx,
        session,
        { userId: staff.userId, roleKey: member.roleRef?.key ?? null },
        'staff link',
      );
    }

    const previous = staff.userId;
    const updated = await tx.staff.updateMany({
      where: { id: staffId, userId: previous },
      data: { userId: null },
    });
    if (updated.count !== 1) {
      throw new ConflictError('this staff record changed concurrently — reload and try again');
    }
    await writeAudit(tx, session, 'update', 'staff', staffId, { unlink: { userId: previous } });
    return { staffId, userId: null, changed: true };
  });
}

// -----------------------------------------------------------------------------
// Membership branches
// -----------------------------------------------------------------------------

export type BranchRef = { id: string; name: string };

/** The organisation's branches, for the Members panel. */
export async function listBranches(session: ActiveSession): Promise<BranchRef[]> {
  return withOrg(session.organizationId, (tx) =>
    tx.branch.findMany({
      orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  );
}

/**
 * Role keys that hold at least one `:branch` permission — the roles for which a
 * membership's branch set changes anything. Read from role_permissions rather
 * than listed in code (CLAUDE.md invariant 7), and used only to decide where the
 * Members panel shows a branch control. roles, permissions and role_permissions
 * are global reference data with no row-level security, readable by the app
 * role, so the ordinary tenant-scoped client is enough.
 */
export async function listBranchScopedRoleKeys(session: ActiveSession): Promise<string[]> {
  const rows = await withOrg(session.organizationId, (tx) =>
    tx.rolePermission.findMany({
      // The KEY suffix, which is what can() 4b evaluates — not permissions.scope:
      // `report.branch` has scope 'branch' but no `:branch` suffix, so can()
      // treats it as scope-less and a branch set changes nothing for it.
      // Organisation plane only: SUPER_ADMIN holds every key, but a branch set
      // belongs to an organisation membership, which a platform role is not.
      where: {
        permissionKey: { endsWith: ':branch' },
        role: { organizationId: null, plane: 'organization' },
      },
      select: { role: { select: { key: true } } },
    }),
  );
  return [...new Set(rows.map((r) => r.role.key))].sort();
}

export type BranchScopeChange = { added: string[]; removed: string[] };

/**
 * Replace a membership's branch set. Idempotent: assigning the set it already
 * has changes nothing and writes no audit row. An empty set is allowed — it is
 * the fail-closed state, and the Members panel says so.
 */
export async function setMemberBranches(
  session: ActiveSession,
  membershipIdInput: unknown,
  branchIdsInput: unknown,
): Promise<BranchScopeChange> {
  const membershipId = requireUuid(membershipIdInput, 'membershipId');
  if (!Array.isArray(branchIdsInput)) throw new InvalidInputError('branchIds must be an array');
  const branchIds = [...new Set(branchIdsInput.map((b) => requireUuid(b, 'branchId')))];
  const actorCtx = await actorContext(session);

  return withOrg(session.organizationId, async (tx) => {
    // RLS: a membership of another organisation is invisible — not found.
    const member = await tx.membership.findUnique({
      where: { id: membershipId },
      select: { userId: true, roleRef: { select: { key: true } } },
    });
    if (!member) throw new NotFoundError('membership not found');
    await assertCanModifyMember(
      actorCtx,
      session,
      { userId: member.userId, roleKey: member.roleRef?.key ?? null },
      'branches',
    );

    // RLS again: only this organisation's branches can come back, so an id
    // from another tenant simply fails to resolve and the whole call refuses.
    const found = await tx.branch.findMany({
      where: { id: { in: branchIds } },
      select: { id: true },
    });
    if (found.length !== branchIds.length) {
      throw new InvalidInputError('one or more branches are not in this organisation');
    }

    const current = await tx.membershipBranch.findMany({
      where: { membershipId },
      select: { branchId: true },
    });
    const have = new Set(current.map((r) => r.branchId));
    const want = new Set(branchIds);
    const added = branchIds.filter((b) => !have.has(b));
    const removed = [...have].filter((b) => !want.has(b));
    if (added.length === 0 && removed.length === 0) return { added, removed };

    if (added.length) {
      await tx.membershipBranch.createMany({
        data: added.map((branchId) => ({ membershipId, branchId })),
        skipDuplicates: true,
      });
    }
    if (removed.length) {
      await tx.membershipBranch.deleteMany({
        where: { membershipId, branchId: { in: removed } },
      });
    }
    await writeAudit(tx, session, 'update', 'membership', membershipId, {
      targetUserId: member.userId,
      branches: { added, removed },
    });
    // Spec §9 rule 10: a change to what a member can reach invalidates their
    // live session, exactly as a role change does.
    await tx.appUser.update({
      where: { id: member.userId },
      data: { sessionVersion: { increment: 1 } },
    });
    return { added, removed };
  });
}

// -----------------------------------------------------------------------------
// Owner decision D1 — the initial branch set.
//
// A FRONT_DESK membership starts with EVERY branch of its organisation, and
// admins narrow from there. Applied where a FRONT_DESK membership comes into
// being: invitation acceptance, a role change into FRONT_DESK, and (for the
// memberships that already existed) migration 20260929000001. A membership that
// already carries a scope is never widened. Branches created later are NOT
// added — an admin assigns them.
//
// Keyed on the role, as D1 was decided for FRONT_DESK specifically. BRANCH_MANAGER
// is the role defined BY a narrow scope (spec §4.2), so it must never be
// defaulted to everything.
// -----------------------------------------------------------------------------
export const ROLES_DEFAULTED_TO_ALL_BRANCHES: ReadonlySet<string> = new Set(['FRONT_DESK']);

/**
 * Give an UNSCOPED membership every branch of its organisation. Returns the
 * branch ids it added — empty when the membership already had a scope or the
 * organisation has no branches. The organisation filter is explicit because
 * invitation acceptance runs without RLS.
 */
export async function assignAllBranchesIfUnscoped(
  tx: TxClient,
  membershipId: string,
  organizationId: string,
): Promise<string[]> {
  const existing = await tx.membershipBranch.count({ where: { membershipId } });
  if (existing > 0) return [];
  const branches = await tx.branch.findMany({
    where: { organizationId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (branches.length === 0) return [];
  const data: Prisma.MembershipBranchCreateManyInput[] = branches.map((b) => ({
    membershipId,
    branchId: b.id,
  }));
  await tx.membershipBranch.createMany({ data, skipDuplicates: true });
  return branches.map((b) => b.id);
}
