'use server';

import { revalidatePath } from 'next/cache';
import type { UserRole } from '@prisma/client';
import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import {
  type AvailabilityWindow,
  createLocation,
  createService,
  createStaff,
  deleteLocation,
  deleteService,
  deleteStaff,
  removeMember,
  setAvailability,
  updateLocation,
  updateMemberRole,
  updateService,
  updateStaff,
} from '@/lib/admin';
import { createInvitation, type CreateInvitationResult } from '@/lib/invitations';

// Every mutation revalidates all four /settings tabs since some cross-
// reference each other (deleting a location removes services + staff view).
const REVALIDATE_ALL = () => {
  revalidatePath('/settings/locations');
  revalidatePath('/settings/staff');
  revalidatePath('/settings/services');
  revalidatePath('/settings/members');
  // Also blast the shell so the header switcher picks up new locations.
  revalidatePath('/', 'layout');
};

async function ctxFor(permission: string, module: string) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, permission, { organizationId: ctx.activeOrganizationId! }, module);
  return ctxToSession(ctx);
}

// -------------------- Locations ---------------------------------------------
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
export async function deleteLocationAction(id: string) {
  const session = await ctxFor('org.branch.manage', 'admin');
  await deleteLocation(session, id);
  REVALIDATE_ALL();
}

// -------------------- Staff --------------------------------------------------
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
export async function deleteStaffAction(id: string) {
  const session = await ctxFor('staff.deactivate', 'admin');
  await deleteStaff(session, id);
  REVALIDATE_ALL();
}
export async function setAvailabilityAction(id: string, windows: AvailabilityWindow[]) {
  const session = await ctxFor('staff.schedule.manage', 'admin');
  await setAvailability(session, id, windows);
  REVALIDATE_ALL();
}

// -------------------- Services -----------------------------------------------
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
export async function deleteServiceAction(id: string) {
  const session = await ctxFor('service.manage', 'admin');
  await deleteService(session, id);
  REVALIDATE_ALL();
}

// -------------------- Members ------------------------------------------------
/**
 * Phase 4: sends an invitation LINK (never a password). The invitee clicks
 * the link and sets their own password. Return shape carries the URL so the
 * UI can show it to the sender (in case email delivery failed / isn't
 * configured).
 */
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
  await updateMemberRole(session, membershipId, role);
  REVALIDATE_ALL();
}
export async function removeMemberAction(membershipId: string) {
  const session = await ctxFor('staff.deactivate', 'admin');
  await removeMember(session, membershipId);
  REVALIDATE_ALL();
}
