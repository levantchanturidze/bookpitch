'use server';

import { revalidatePath } from 'next/cache';
import type { UserRole } from '@prisma/client';
import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { type ActionResult } from '@/lib/action-result';
import { safeAction } from '@/lib/safe-action';
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

// -----------------------------------------------------------------------------
// U-01: every action here RETURNS an ActionResult. None of them throws across
// the Server Action boundary.
//
// Before, most of these threw and the client did
// `catch (err) { setError((err as Error).message) }` — which in production
// renders the framework's masked text, not the domain message. Three delete
// actions already returned `{ ok, error }`, proving the pattern was known; it
// simply was not applied. They are folded onto the shared `ActionResult` shape
// so there is now exactly one contract, not two.
//
// Permission checks stay INSIDE the wrapped body on purpose: a ForbiddenError
// from requirePermission must travel the same path as any other refusal and
// come back as `{ ok: false, code: 'forbidden' }` — fail-closed, and legible.
// -----------------------------------------------------------------------------

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
  return safeAction('settings.createLocation', async () => {
    const session = await ctxFor('org.branch.manage', 'admin');
    const result = await createLocation(session, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function updateLocationAction(id: string, input: unknown) {
  return safeAction('settings.updateLocation', async () => {
    const session = await ctxFor('org.branch.manage', 'admin');
    const result = await updateLocation(session, id, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function deleteLocationAction(id: string): Promise<ActionResult<void>> {
  return safeAction('settings.deleteLocation', async () => {
    const session = await ctxFor('org.branch.manage', 'admin');
    requireExactCleanupId(id, 'locationId');
    await deleteLocation(session, id);
    REVALIDATE_ALL();
  });
}

export async function createStaffAction(input: unknown) {
  return safeAction('settings.createStaff', async () => {
    const session = await ctxFor('staff.update', 'admin');
    const result = await createStaff(session, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function updateStaffAction(id: string, input: unknown) {
  return safeAction('settings.updateStaff', async () => {
    const session = await ctxFor('staff.update', 'admin');
    const result = await updateStaff(session, id, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function deleteStaffAction(id: string): Promise<ActionResult<void>> {
  return safeAction('settings.deleteStaff', async () => {
    const session = await ctxFor('staff.deactivate', 'admin');
    await assertStaffHardDeleteSafe(session, id);
    await deleteStaff(session, id);
    REVALIDATE_ALL();
  });
}

export async function setAvailabilityAction(id: string, windows: AvailabilityWindow[]) {
  return safeAction('settings.setAvailability', async () => {
    const session = await ctxFor('staff.schedule.manage', 'admin');
    // STAGE C stores the editor's digits unchanged.
    //
    // The local -> UTC conversion is gone. It was the original defect: it
    // shifted the TIME modularly across midnight while leaving `weekday` as the
    // LOCAL day, so a window whose UTC form crossed midnight was filed against
    // the wrong day — and it used TODAY's offset rather than the offset on the
    // date actually being booked.
    //
    // The offset is now applied exactly once, at enforcement, against the
    // appointment's own date. What the operator types is what is stored.
    //
    // setAvailability() rejects end <= start with a written message. U-01 was
    // that the message never arrived; it now travels as `code: 'invalid_input'`.
    const result = await setAvailability(session, id, windows);
    REVALIDATE_ALL();
    return result;
  });
}

export async function createServiceAction(input: unknown) {
  return safeAction('settings.createService', async () => {
    const session = await ctxFor('service.manage', 'admin');
    const result = await createService(session, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function updateServiceAction(id: string, input: unknown) {
  return safeAction('settings.updateService', async () => {
    const session = await ctxFor('service.manage', 'admin');
    const result = await updateService(session, id, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function deleteServiceAction(id: string): Promise<ActionResult<void>> {
  return safeAction('settings.deleteService', async () => {
    const session = await ctxFor('service.manage', 'admin');
    await cleanupServiceById(session, id);
    REVALIDATE_ALL();
  });
}

export async function inviteMemberAction(input: {
  email: string;
  role: UserRole;
}): Promise<ActionResult<CreateInvitationResult>> {
  return safeAction('settings.inviteMember', async () => {
    const session = await ctxFor('staff.invite', 'admin');
    const result = await createInvitation(session, input);
    REVALIDATE_ALL();
    return result;
  });
}

export async function updateMemberRoleAction(membershipId: string, role: UserRole) {
  return safeAction('settings.updateMemberRole', async () => {
    const session = await ctxFor('staff.role.assign', 'admin');
    requireExactCleanupId(membershipId, 'membershipId');
    // A rank/lattice refusal from updateMemberRole is a privilege-escalation
    // denial. It must reach the operator as a sentence, not as a crash.
    await updateMemberRole(session, membershipId, role);
    REVALIDATE_ALL();
  });
}

export async function removeMemberAction(membershipId: string) {
  return safeAction('settings.removeMember', async () => {
    const session = await ctxFor('staff.deactivate', 'admin');
    requireExactCleanupId(membershipId, 'membershipId');
    await removeMember(session, membershipId);
    REVALIDATE_ALL();
  });
}
