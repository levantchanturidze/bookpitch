import type { LocationType, UserRole } from '@prisma/client';
import { ConflictError, InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { assertNotLastOwner, assertOrgOwnerSet } from '@/lib/admin/last-owner';
import { canManageRoleAssignment, buildAuthContext } from '@/lib/rbac';
import { mapPrismaError } from '@/lib/prisma-error';

// -----------------------------------------------------------------------------
// Admin service (owner-only). Every mutation is scoped via withOrg (RLS +
// tenancy inheritance) and writes to audit_log. Deletes that would violate a
// FK constraint (Prisma P2003) surface as ConflictError → 409 upstream.
// -----------------------------------------------------------------------------

function catchPrismaFk(err: unknown, message: string): never {
  // Used by deleteStaff — Prisma raises P2003 on FK violation (appointments).
  const code = (err as { code?: string } | null)?.code;
  if (code === 'P2003') throw new ConflictError(message);
  throw err;
}

const LOCATION_TYPES: LocationType[] = ['clinic', 'salon'];
const USER_ROLES: UserRole[] = ['owner', 'practitioner', 'receptionist'];

// -----------------------------------------------------------------------------
// LOCATIONS
// -----------------------------------------------------------------------------

export type LocationInput = {
  type: LocationType;
  name: string;
  timezone?: string;
  taxRate?: number;
  publicSlug?: string | null;
};

function parseLocationInput(body: unknown): LocationInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.type !== 'string' || !LOCATION_TYPES.includes(b.type as LocationType)) {
    throw new InvalidInputError('type must be clinic or salon');
  }
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new InvalidInputError('name is required');
  let publicSlug: string | null | undefined;
  if ('publicSlug' in b) {
    const raw = typeof b.publicSlug === 'string' ? b.publicSlug.trim().toLowerCase() : '';
    if (raw && !/^[a-z0-9-]+$/.test(raw)) {
      throw new InvalidInputError('publicSlug must be lowercase letters, digits, and hyphens only');
    }
    publicSlug = raw || null;
  }
  return {
    type: b.type as LocationType,
    name,
    timezone: typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : undefined,
    taxRate: typeof b.taxRate === 'number' ? b.taxRate : undefined,
    publicSlug,
  };
}

export async function listLocations(session: ActiveSession) {
  return withOrg(session.organizationId, (tx) =>
    tx.location.findMany({
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { staff: true, appointments: true, services: true } },
      },
    }),
  );
}

export async function createLocation(session: ActiveSession, body: unknown) {
  const input = parseLocationInput(body);
  return withOrg(session.organizationId, async (tx) => {
    try {
      const row = await tx.location.create({
        data: {
          organizationId: session.organizationId,
          type: input.type,
          name: input.name,
          timezone: input.timezone,
          taxRate: input.taxRate,
          ...(input.publicSlug !== undefined ? { publicSlug: input.publicSlug } : {}),
        },
      });
      await writeAudit(tx, session, 'create', 'staff', null, { location: row.id, name: row.name });
      return row;
    } catch (e) {
      mapPrismaError(e);
    }
  });
}

export async function updateLocation(session: ActiveSession, id: string, body: unknown) {
  const input = parseLocationInput(body);
  return withOrg(session.organizationId, async (tx) => {
    try {
      const row = await tx.location.update({
        where: { id },
        data: {
          type: input.type,
          name: input.name,
          timezone: input.timezone,
          taxRate: input.taxRate,
          ...(input.publicSlug !== undefined ? { publicSlug: input.publicSlug } : {}),
        },
      });
      await writeAudit(tx, session, 'update', 'staff', null, { location: id });
      return row;
    } catch (e) {
      mapPrismaError(e);
    }
  });
}

export async function deleteLocation(session: ActiveSession, id: string) {
  return withOrg(session.organizationId, async (tx) => {
    // The schema's ON DELETE CASCADE would silently drop staff + services
    // + appointments. That's rarely what an owner intended — refuse
    // instead and force them to move/cancel dependents first.
    const location = await tx.location.findUnique({
      where: { id },
      include: {
        _count: { select: { staff: true, appointments: true, services: true } },
      },
    });
    if (!location) throw new InvalidInputError('location not found');
    const c = location._count;
    if (c.staff + c.appointments + c.services > 0) {
      throw new ConflictError(
        `Location has ${c.staff} staff · ${c.services} services · ${c.appointments} appointments — remove or reassign them first.`,
      );
    }
    await tx.location.delete({ where: { id } });
    await writeAudit(tx, session, 'delete', 'staff', null, { location: id });
  });
}

// -----------------------------------------------------------------------------
// STAFF + AVAILABILITY
// -----------------------------------------------------------------------------

export type StaffInput = {
  locationId: string;
  name: string;
  roleTitle: string;
  specialty?: string | null;
  email?: string | null;
  phone?: string | null;
  calendarColor?: string | null;
};

export type AvailabilityWindow = {
  weekday: number; // 0=Sun … 6=Sat
  startTime: string; // HH:MM
  endTime: string; // HH:MM
};

function parseStaffInput(body: unknown): StaffInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.locationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.locationId)) {
    throw new InvalidInputError('locationId must be a uuid');
  }
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const roleTitle = typeof b.roleTitle === 'string' ? b.roleTitle.trim() : '';
  if (!name) throw new InvalidInputError('name is required');
  if (!roleTitle) throw new InvalidInputError('roleTitle is required');
  const asOptional = (k: string) =>
    typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null;
  return {
    locationId: b.locationId,
    name,
    roleTitle,
    specialty: asOptional('specialty'),
    email: asOptional('email'),
    phone: asOptional('phone'),
    calendarColor: asOptional('calendarColor'),
  };
}

export async function listStaff(session: ActiveSession) {
  return withOrg(session.organizationId, (tx) =>
    tx.staff.findMany({
      orderBy: { name: 'asc' },
      include: {
        availability: { orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] },
      },
    }),
  );
}

export async function createStaff(session: ActiveSession, body: unknown) {
  const input = parseStaffInput(body);
  return withOrg(session.organizationId, async (tx) => {
    const row = await tx.staff.create({
      data: {
        organizationId: session.organizationId,
        locationId: input.locationId,
        name: input.name,
        roleTitle: input.roleTitle,
        specialty: input.specialty,
        email: input.email,
        phone: input.phone,
        calendarColor: input.calendarColor,
      },
    });
    await writeAudit(tx, session, 'create', 'staff', row.id);
    return row;
  });
}

export async function updateStaff(session: ActiveSession, id: string, body: unknown) {
  const input = parseStaffInput(body);
  return withOrg(session.organizationId, async (tx) => {
    const row = await tx.staff.update({
      where: { id },
      data: {
        locationId: input.locationId,
        name: input.name,
        roleTitle: input.roleTitle,
        specialty: input.specialty,
        email: input.email,
        phone: input.phone,
        calendarColor: input.calendarColor,
      },
    });
    await writeAudit(tx, session, 'update', 'staff', id);
    return row;
  });
}

export async function deleteStaff(session: ActiveSession, id: string) {
  return withOrg(session.organizationId, async (tx) => {
    // Phase 6 spec §9 rule 5: provider deletion blocked while future
    // bookings exist. Cancelled + completed appointments don't count —
    // they're history that shouldn't block cleanup.
    const futureBookings = await tx.appointment.count({
      where: {
        staffId: id,
        startsAt: { gt: new Date() },
        status: { notIn: ['cancelled', 'completed'] },
      },
    });
    if (futureBookings > 0) {
      throw new ConflictError(
        `provider has ${futureBookings} future booking(s) — cancel or reassign first (spec §9 rule 5)`,
      );
    }
    try {
      await tx.staff.delete({ where: { id } });
      await writeAudit(tx, session, 'delete', 'staff', id);
    } catch (err) {
      catchPrismaFk(err, 'Staff has appointments — cancel or reassign first.');
    }
  });
}

export async function setAvailability(
  session: ActiveSession,
  staffId: string,
  windows: AvailabilityWindow[],
) {
  // Simple validation: weekday 0-6, HH:MM start < end, no overlaps per weekday.
  const byDay = new Map<number, AvailabilityWindow[]>();
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) {
      throw new InvalidInputError('weekday must be 0..6');
    }
    if (!/^\d{2}:\d{2}$/.test(w.startTime) || !/^\d{2}:\d{2}$/.test(w.endTime)) {
      throw new InvalidInputError('times must be HH:MM');
    }
    const [sh, sm] = w.startTime.split(':').map(Number);
    const [eh, em] = w.endTime.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) {
      throw new InvalidInputError(`window ${w.startTime}-${w.endTime} has end <= start`);
    }
    const list = byDay.get(w.weekday) ?? [];
    list.push(w);
    byDay.set(w.weekday, list);
  }

  return withOrg(session.organizationId, async (tx) => {
    await tx.staffAvailability.deleteMany({ where: { staffId } });
    if (windows.length > 0) {
      await tx.staffAvailability.createMany({
        data: windows.map((w) => ({
          staffId,
          weekday: w.weekday,
          startTime: new Date(`1970-01-01T${w.startTime}:00Z`),
          endTime: new Date(`1970-01-01T${w.endTime}:00Z`),
        })),
      });
    }
    await writeAudit(tx, session, 'update', 'staff', staffId, { availability: windows.length });
  });
}

// -----------------------------------------------------------------------------
// SERVICES
// -----------------------------------------------------------------------------

export type ServiceInput = {
  locationId: string;
  name: string;
  category?: string | null;
  price: number;
  durationMinutes: number;
  isActive?: boolean;
};

function parseServiceInput(body: unknown): ServiceInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.locationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.locationId)) {
    throw new InvalidInputError('locationId must be a uuid');
  }
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new InvalidInputError('name is required');
  const price = typeof b.price === 'number' ? b.price : Number(b.price);
  if (!Number.isFinite(price) || price < 0) throw new InvalidInputError('price must be >= 0');
  const duration =
    typeof b.durationMinutes === 'number' ? b.durationMinutes : Number(b.durationMinutes);
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new InvalidInputError('durationMinutes must be a positive integer');
  }
  return {
    locationId: b.locationId,
    name,
    category: typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null,
    price,
    durationMinutes: duration,
    isActive: typeof b.isActive === 'boolean' ? b.isActive : true,
  };
}

export async function listServices(session: ActiveSession) {
  return withOrg(session.organizationId, (tx) =>
    tx.service.findMany({ orderBy: [{ locationId: 'asc' }, { name: 'asc' }] }),
  );
}

export async function createService(session: ActiveSession, body: unknown) {
  const input = parseServiceInput(body);
  return withOrg(session.organizationId, async (tx) => {
    const row = await tx.service.create({
      data: {
        organizationId: session.organizationId,
        locationId: input.locationId,
        name: input.name,
        category: input.category,
        price: input.price,
        durationMinutes: input.durationMinutes,
        isActive: input.isActive ?? true,
      },
    });
    await writeAudit(tx, session, 'create', 'staff', null, { service: row.id, name: row.name });
    return row;
  });
}

export async function updateService(session: ActiveSession, id: string, body: unknown) {
  const input = parseServiceInput(body);
  return withOrg(session.organizationId, async (tx) => {
    const row = await tx.service.update({
      where: { id },
      data: {
        locationId: input.locationId,
        name: input.name,
        category: input.category,
        price: input.price,
        durationMinutes: input.durationMinutes,
        isActive: input.isActive ?? true,
      },
    });
    await writeAudit(tx, session, 'update', 'staff', null, { service: id });
    return row;
  });
}

export async function deleteService(session: ActiveSession, id: string) {
  return withOrg(session.organizationId, async (tx) => {
    // Services are ON DELETE SET NULL on appointments — safe to delete
    // (appointment.serviceName is snapshotted).
    await tx.service.delete({ where: { id } });
    await writeAudit(tx, session, 'delete', 'staff', null, { service: id });
  });
}

// -----------------------------------------------------------------------------
// MEMBERS (org-scoped users)
// -----------------------------------------------------------------------------

export type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  createdAt: string;
};

// inviteMember + its InviteInput / parseInviteInput / tempPassword flow were
// removed in Phase 4 (Phase 0 R4). New invitations go through the token-based
// flow: components/settings/actions.ts::inviteMemberAction → lib/invitations.ts.
// The spec invariant (§9 rule 4: admins never set passwords) is now the only
// path.

export async function listMembers(session: ActiveSession): Promise<MemberRow[]> {
  // Memberships table is RLS-scoped to the org; app_users itself isn't.
  return withOrg(session.organizationId, async (tx) => {
    const memberships = await tx.membership.findMany({
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    });
    return memberships.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      email: m.user.email,
      fullName: m.user.fullName,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    }));
  });
}

// Map legacy enum → target roles.key for the rank/lattice check.
const ENUM_TO_KEY: Record<UserRole, string> = {
  owner: 'ORG_OWNER',
  practitioner: 'PROVIDER',
  receptionist: 'FRONT_DESK',
};

export async function updateMemberRole(
  session: ActiveSession,
  membershipId: string,
  role: UserRole,
) {
  if (!USER_ROLES.includes(role)) throw new InvalidInputError('invalid role');
  const targetKey = ENUM_TO_KEY[role];

  // Phase 6 guardrail 1: rank + lattice check on the ACTOR's role.
  // Must happen BEFORE the withOrg tx so the actor's AuthContext is
  // resolved outside a tenant-locked connection.
  const actorCtx = session.membershipId
    ? await buildAuthContext(session.userId, session.membershipId)
    : null;
  if (!actorCtx) throw new InvalidInputError('actor has no active membership in this org');
  const canManage = await canManageRoleAssignment(actorCtx, targetKey);
  if (!canManage) {
    throw new InvalidInputError(`your role cannot assign the ${targetKey} role`);
  }

  return withOrg(session.organizationId, async (tx) => {
    await assertOrgOwnerSet(tx, session.organizationId);
    const existing = await tx.membership.findUnique({
      where: { id: membershipId },
      select: { userId: true, roleRef: { select: { key: true } } },
    });
    if (!existing) throw new InvalidInputError('membership not found');
    if (existing.userId === session.userId) {
      throw new InvalidInputError('you cannot change your own role');
    }

    // Phase 6 guardrail 2: rank check on the CURRENT role of the target
    // (spec §9 rule 3 — cannot modify a peer or superior).
    if (existing.roleRef?.key) {
      const canManageCurrent = await canManageRoleAssignment(actorCtx, existing.roleRef.key);
      if (!canManageCurrent) {
        throw new InvalidInputError(`your role cannot modify a ${existing.roleRef.key} member`);
      }
    }

    // Phase 6 guardrail 3: last-owner protection (spec §9 rule 1).
    // If the target is the last ORG_OWNER and we're demoting them, refuse.
    if (targetKey !== 'ORG_OWNER') {
      await assertNotLastOwner(tx, session.organizationId, membershipId);
    }

    // Perform the enum + role_id update. Post-Phase-4, role_id is the
    // authoritative pointer; the legacy enum is kept in sync for
    // during-Contract compatibility.
    const roleRow = await tx.role.findFirstOrThrow({
      where: { key: targetKey, organizationId: null },
      select: { id: true },
    });
    const row = await tx.membership.update({
      where: { id: membershipId },
      data: { role, roleId: roleRow.id },
    });
    await writeAudit(tx, session, 'update', 'staff', existing.userId, { member: true, role });

    // Phase 6 guardrail 4 (spec §9 rule 10): sessions invalidate on role
    // change. Bump the TARGET user's sessionVersion — their live JWT
    // gets kicked within SV_TTL_MS (5s) and the AuthContext cache
    // rebuilds with the new role.
    await tx.appUser.update({
      where: { id: existing.userId },
      data: { sessionVersion: { increment: 1 } },
    });

    return row;
  });
}

export async function removeMember(session: ActiveSession, membershipId: string) {
  return withOrg(session.organizationId, async (tx) => {
    await assertOrgOwnerSet(tx, session.organizationId);
    const existing = await tx.membership.findUnique({
      where: { id: membershipId },
      select: { userId: true, roleRef: { select: { key: true } } },
    });
    if (!existing) throw new InvalidInputError('membership not found');
    if (existing.userId === session.userId) {
      throw new InvalidInputError('you cannot remove yourself');
    }

    // Phase 6 guardrail: rank check — you can't remove a peer or superior
    // (spec §9 rule 3). buildAuthContext outside the tx so it doesn't
    // fight the tenant-locked connection.
    const actorCtx = session.membershipId
      ? await buildAuthContext(session.userId, session.membershipId)
      : null;
    if (!actorCtx) throw new InvalidInputError('actor has no active membership');
    if (existing.roleRef?.key) {
      const canManage = await canManageRoleAssignment(actorCtx, existing.roleRef.key);
      if (!canManage) {
        throw new InvalidInputError(`your role cannot remove a ${existing.roleRef.key} member`);
      }
    }

    // Phase 6 guardrail: last-owner protection (spec §9 rule 1).
    await assertNotLastOwner(tx, session.organizationId, membershipId);

    await tx.membership.delete({ where: { id: membershipId } });
    await writeAudit(tx, session, 'delete', 'staff', existing.userId, { member: true });

    // Phase 6 (spec §9 rule 10): bump session so the removed user's
    // live JWT is rejected on the next request.
    await tx.appUser.update({
      where: { id: existing.userId },
      data: { sessionVersion: { increment: 1 } },
    });
  });
}
