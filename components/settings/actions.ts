'use server';

import { revalidatePath } from 'next/cache';
import type { UserRole } from '@prisma/client';
import { ConflictError, InvalidInputError, ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { localHHMMToUtcHHMM } from '@/lib/tz';
import {
  type AvailabilityWindow,
  createLocation,
  createService,
  createStaff,
  deleteLocation,
  deleteStaff,
  removeMember,
  setAvailability,
  updateLocation,
  updateMemberRole,
  updateService,
  updateStaff,
} from '@/lib/admin';
import { createInvitation, type CreateInvitationResult } from '@/lib/invitations';
import {
  assertStaffHardDeleteSafe,
  cleanupServiceById,
  requireExactCleanupId,
} from '@/lib/cleanup-lifecycle';

const REVALIDATE_ALL = () => {
  revalidatePath('/settings/locations');
  revalidatePath('/settings/staff');
  revalidatePath('/settings/services');
  revalidatePath('/settings/members');
  revalidatePath('/', 'layout');
};

async function ctxFor(permission: string, module: string) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, permission, { organizationId: ctx.activeOrganizationId! }, module);
  return ctxToSession(ctx);
}

export async function createLocationAction(input: unknown) {
  const session = await ctxFor('org.branch.manage', 'admin');
  const result = await createLocation(session, input);
  REVALIDATE_ALL();
  return result;
}
export async function updateLocationAction(id: string, input: unknown) {
  const session = await ctxFor('org.branch.manage', 'admin');
  const result = await updateLocation(session, id, input);
  REVALIDATE_ALL();
  return result;
}
export type DeleteResult = { ok: true } | { ok: false; error: string };

export async function deleteLocationAction(id: string): Promise<DeleteResult> {
  const session = await ctxFor('org.branch.manage', 'admin');
  try {
    requireExactCleanupId(id, 'locationId');
    await deleteLocation(session, id);
    REVALIDATE_ALL();
    return { ok: true };
  } catch (err) {
    if (err instanceof ConflictError || err instanceof InvalidInputError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

export async function createStaffAction(input: unknown) {
  const session = await ctxFor('staff.update', 'admin');
  const result = await createStaff(session, input);
  REVALIDATE_ALL();
  return result;
}
export async function updateStaffAction(id: string, input: unknown) {
  const session = await ctxFor('staff.update', 'admin');
  const result = await updateStaff(session, id, input);
  REVALIDATE_ALL();
  return result;
}
export async function deleteStaffAction(id: string): Promise<DeleteResult> {
  const session = await ctxFor('staff.deactivate', 'admin');
  try {
    await assertStaffHardDeleteSafe(session, id);
    await deleteStaff(session, id);
    REVALIDATE_ALL();
    return { ok: true };
  } catch (err) {
    if (err instanceof ConflictError || err instanceof InvalidInputError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
export async function setAvailabilityAction(id: string, windows: AvailabilityWindow[]) {
  const session = await ctxFor('staff.schedule.manage', 'admin');
  // STAGE B converts local -> UTC before storing, because Stage B still writes
  // the legacy form (see setAvailability). The editor speaks local wall-clock,
  // the column holds UTC, and time_basis now records that outright instead of
  // leaving a reader to infer it.
  //
  // Stage C drops this conversion and stores the local digits directly, once no
  // pre-marker instance can still misread them as UTC.
  const staffRec = await withOrg(session.organizationId, (tx) =>
    tx.staff.findUnique({
      where: { id },
      select: { location: { select: { timezone: true } } },
    }),
  );
  const tz = staffRec?.location.timezone ?? 'UTC';
  const utcWindows: AvailabilityWindow[] = windows.map((w) => ({
    weekday: w.weekday,
    startTime: localHHMMToUtcHHMM(w.startTime, tz),
    endTime: localHHMMToUtcHHMM(w.endTime, tz),
  }));
  const result = await setAvailability(session, id, utcWindows);
  REVALIDATE_ALL();
  return result;
}

export async function createServiceAction(input: unknown) {
  const session = await ctxFor('service.manage', 'admin');
  const result = await createService(session, input);
  REVALIDATE_ALL();
  return result;
}
export async function updateServiceAction(id: string, input: unknown) {
  const session = await ctxFor('service.manage', 'admin');
  const result = await updateService(session, id, input);
  REVALIDATE_ALL();
  return result;
}
export async function deleteServiceAction(id: string): Promise<DeleteResult> {
  const session = await ctxFor('service.manage', 'admin');
  try {
    await cleanupServiceById(session, id);
    REVALIDATE_ALL();
    return { ok: true };
  } catch (err) {
    if (err instanceof ConflictError || err instanceof InvalidInputError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

export async function inviteMemberAction(input: {
  email: string;
  role: UserRole;
}): Promise<CreateInvitationResult> {
  const session = await ctxFor('staff.invite', 'admin');
  const result = await createInvitation(session, input);
  REVALIDATE_ALL();
  return result;
}
export async function updateMemberRoleAction(membershipId: string, role: UserRole) {
  const session = await ctxFor('staff.role.assign', 'admin');
  requireExactCleanupId(membershipId, 'membershipId');
  await updateMemberRole(session, membershipId, role);
  REVALIDATE_ALL();
}
export async function removeMemberAction(membershipId: string) {
  const session = await ctxFor('staff.deactivate', 'admin');
  requireExactCleanupId(membershipId, 'membershipId');
  await removeMember(session, membershipId);
  REVALIDATE_ALL();
}
