// -----------------------------------------------------------------------------
// Platform-plane role assignment (spec §6.1 row "Platform-როლების დარიგება").
// SUPER_ADMIN only — enforced via `platform.role.assign` permission which
// the seed grants to SUPER_ADMIN alone.
// -----------------------------------------------------------------------------

import { prismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import type { AuthContext } from '@/lib/rbac';
import { log } from '@/lib/logger';

const PLATFORM_ROLE_KEYS = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_AGENT', 'BILLING_MANAGER'] as const;
export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number] | null;

export type PlatformRoleHolder = {
  userId: string;
  email: string;
  fullName: string | null;
  roleKey: string;
  rolePlane: string;
  assignedAt: Date | null;
};

/** List every user who currently holds a platform-plane role. */
export async function listPlatformRoleHolders(): Promise<PlatformRoleHolder[]> {
  const rows = await prismaAdmin.appUser.findMany({
    where: { platformRoleId: { not: null } },
    select: {
      id: true, email: true, fullName: true, createdAt: true,
      platformRole: { select: { key: true, plane: true } },
    },
    orderBy: { email: 'asc' },
  });
  return rows
    .filter((r) => r.platformRole !== null)
    .map((r) => ({
      userId: r.id,
      email: r.email,
      fullName: r.fullName,
      roleKey: r.platformRole!.key,
      rolePlane: r.platformRole!.plane,
      assignedAt: r.createdAt,
    }));
}

/**
 * Assign or clear a platform role for the target user (looked up by email).
 * Passing roleKey=null revokes the platform role entirely. Always bumps the
 * target's sessionVersion so any live JWT sees the change within ~5s.
 * Writes an append-only audit_log row.
 *
 * Spec §9 rule 2 (no rank inversion) enforced here: only SUPER_ADMIN can
 * grant SUPER_ADMIN — but this whole endpoint is already gated on
 * `platform.role.assign` which the seed reserves to SUPER_ADMIN, so any
 * caller reaching this function is already SUPER_ADMIN. Guard is defensive.
 */
export async function assignPlatformRole(
  actor: AuthContext,
  targetEmail: string,
  roleKey: PlatformRoleKey,
): Promise<{ userId: string; newRoleKey: PlatformRoleKey; previousRoleKey: string | null }> {
  const email = targetEmail.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new InvalidInputError('email is invalid');
  }
  if (roleKey !== null && !PLATFORM_ROLE_KEYS.includes(roleKey)) {
    throw new InvalidInputError(`roleKey must be one of: ${PLATFORM_ROLE_KEYS.join(', ')}, or null`);
  }

  // Defensive: caller must have SUPER_ADMIN to grant SUPER_ADMIN. Since the
  // route-level guard is `platform.role.assign` (SUPER-only per seed) this
  // is belt-and-braces; a bug that widens the perm elsewhere won't leak here.
  const actorUser = await prismaAdmin.appUser.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { platformRole: { select: { key: true } } },
  });
  const actorRoleKey = actorUser.platformRole?.key ?? null;
  if (roleKey === 'SUPER_ADMIN' && actorRoleKey !== 'SUPER_ADMIN') {
    throw new InvalidInputError('only SUPER_ADMIN can grant SUPER_ADMIN');
  }

  const target = await prismaAdmin.appUser.findUnique({
    where: { email },
    select: {
      id: true, platformRole: { select: { id: true, key: true } },
    },
  });
  if (!target) throw new InvalidInputError('user not found');

  const previousRoleKey = target.platformRole?.key ?? null;

  // SEC-006: last-SUPER_ADMIN protection. If this mutation would remove the
  // final SUPER_ADMIN from the system, refuse — `platform.role.assign` is
  // SUPER-only, so a zero-SUPER state is unrecoverable without dropping into
  // the DB SQL editor. Analog of spec §9 rule 1 for the platform plane.
  // Catches BOTH the self-revoke case (SUPER demoting themselves) and the
  // peer-revoke case (SUPER demoting the other SUPER when they're the last
  // two).
  if (previousRoleKey === 'SUPER_ADMIN' && roleKey !== 'SUPER_ADMIN') {
    const superRole = await prismaAdmin.role.findFirstOrThrow({
      where: { key: 'SUPER_ADMIN', organizationId: null }, select: { id: true },
    });
    const others = await prismaAdmin.appUser.count({
      where: {
        platformRoleId: superRole.id,
        id: { not: target.id },
        status: 'active',
      },
    });
    if (others === 0) {
      throw new InvalidInputError(
        'must keep at least one active SUPER_ADMIN — grant SUPER_ADMIN to another user first, then revoke this one',
      );
    }
  }

  let newRoleId: string | null = null;
  if (roleKey !== null) {
    const role = await prismaAdmin.role.findFirstOrThrow({
      where: { key: roleKey, organizationId: null }, select: { id: true },
    });
    newRoleId = role.id;
  }

  await prismaAdmin.$transaction([
    prismaAdmin.appUser.update({
      where: { id: target.id },
      data: {
        platformRoleId: newRoleId,
        sessionVersion: { increment: 1 },
      },
    }),
    prismaAdmin.auditLog.create({
      data: {
        organizationId: null,   // platform-scoped action
        actorUserId: actor.userId,
        action: roleKey === null ? 'platform.role.revoke' : 'platform.role.assign',
        entity: 'staff',
        entityId: target.id,
        meta: {
          targetEmail: email,
          newRoleKey: roleKey,
          previousRoleKey,
        },
      },
    }),
  ]);

  log.info('platform.role.assigned', {
    actorUserId: actor.userId, targetUserId: target.id,
    previousRoleKey, newRoleKey: roleKey,
  });

  return { userId: target.id, newRoleKey: roleKey, previousRoleKey };
}
