// -----------------------------------------------------------------------------
// RBAC Phase 6 — two-step organization ownership transfer (spec §4.2).
//
// Nominate → Accept:
//   1. Current ORG_OWNER calls `nominateTransfer(actor, toUserId)`.
//      Writes an ownership_transfers row (status='pending', 7-day
//      expiry), notifies the nominee (in-app notification + email),
//      bumps the nominee's sessionVersion so their next request sees
//      it.
//   2. Nominee accepts via `acceptTransfer(nominee, transferId)` — one
//      transaction swaps organizations.owner_user_id, promotes the
//      nominee to ORG_OWNER, demotes the previous owner to ORG_ADMIN.
//      Both parties' sessionVersions bump so their JWTs see the new
//      roles within 5s.
//   3. Nominee can decline (declineTransfer). Original owner can
//      revoke a pending transfer (revokeTransfer).
//
// Expiry is checked lazily on accept — a pending row past `expires_at`
// gets flipped to `status='expired'`. A housekeeping cron can also sweep.
// -----------------------------------------------------------------------------

import { unsafePrismaAdmin, withOrg } from '@/lib/db';
import { InvalidInputError, ConflictError, NotFoundError, type ActiveSession } from '@/lib/auth';
import { notifyEvent } from '@/lib/notifications';
import { getEmailProvider } from '@/lib/messaging';
import { log, sanitizeErrorMessage } from '@/lib/logger';

const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // spec §4.2 — sensible default

export async function nominateTransfer(
  session: ActiveSession,
  toUserId: string,
): Promise<{ id: string; expiresAt: Date }> {
  if (toUserId === session.userId) {
    throw new InvalidInputError('you cannot nominate yourself');
  }

  return withOrg(session.organizationId, async (tx) => {
    // Target must already be an active member of the org.
    const targetMembership = await tx.membership.findFirst({
      where: { userId: toUserId, organizationId: session.organizationId, status: 'active' },
      select: { id: true },
    });
    if (!targetMembership) {
      throw new InvalidInputError('target is not a member of this organization');
    }

    // Actor must currently be the org's ORG_OWNER (owner_user_id
    // pointer). This is stricter than the perm — we don't want an
    // ORG_ADMIN who happens to have `org.ownership.transfer` to
    // reassign someone else's ownership.
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: session.organizationId },
      select: { ownerUserId: true, name: true, id: true },
    });
    if (org.ownerUserId !== session.userId) {
      throw new InvalidInputError('only the current organization owner can nominate a transfer');
    }

    // Refuse if a pending transfer already exists — enforced by the DB
    // partial unique index too, but the app-level error is friendlier.
    const existing = await tx.ownershipTransfer.findFirst({
      where: { organizationId: session.organizationId, status: 'pending' },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError('a pending ownership transfer already exists for this organization');
    }

    const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS);
    const row = await tx.ownershipTransfer.create({
      data: {
        organizationId: session.organizationId,
        fromUserId: session.userId,
        toUserId,
        expiresAt,
      },
    });

    // In-app notification for the nominee. Best-effort: any failure
    // here is logged but not fatal — the row exists and the endpoint
    // can still be hit directly.
    try {
      await notifyEvent(tx, session.organizationId, {
        type: 'system',
        title: `You've been nominated as owner of ${org.name}`,
        body: `Accept or decline in Settings → Ownership. Expires ${expiresAt.toISOString()}.`,
      });
    } catch (err) {
      log.warn('platform.ownership_transfer.notify_failed', { err: sanitizeErrorMessage(err) });
    }

    return { id: row.id, expiresAt };
  }).then(async (result) => {
    // Email + sessionVersion bump happen AFTER the tx (they cross
    // tenants — the nominee's app_user isn't guaranteed to be reachable
    // from the org-scoped tx handle).
    const nominee = await unsafePrismaAdmin.appUser.findUnique({
      where: { id: toUserId },
      select: { email: true },
    });
    if (nominee?.email) {
      try {
        const provider = getEmailProvider();
        await provider.send(
          nominee.email,
          '[Bookpitch] You have been nominated as organization owner',
          `The current owner of your Bookpitch organization has nominated you as the new owner.\n\n` +
            `Accept or decline in Settings → Ownership.\n` +
            `The nomination expires on ${result.expiresAt.toISOString()}.`,
        );
      } catch (err) {
        log.warn('platform.ownership_transfer.email_failed', { err: sanitizeErrorMessage(err) });
      }
    }
    // Bump nominee sessionVersion so their AuthContext rebuilds and any
    // "pending transfers" UI badge appears within 5s.
    await unsafePrismaAdmin.appUser.update({
      where: { id: toUserId },
      data: { sessionVersion: { increment: 1 } },
    });
    log.info('platform.ownership_transfer.nominated', {
      transferId: result.id,
      fromUserId: session.userId,
      toUserId,
      organizationId: session.organizationId,
    });
    return result;
  });
}

export async function acceptTransfer(
  session: ActiveSession,
  transferId: string,
): Promise<{ ok: true }> {
  // Fetch the transfer outside a tenant-scoped tx — the nominee may not
  // yet have the org's active membership pointer we expect. SEC-007
  // hardening: the WHERE clause carries `toUserId = session.userId` so a
  // caller who doesn't own the transfer gets `null` (mapped to 404)
  // instead of "found but not for you" (400). Kills transferId
  // enumeration — no error-shape distinguishes "doesn't exist" from
  // "exists but not for you."
  const transfer = await unsafePrismaAdmin.ownershipTransfer.findFirst({
    where: { id: transferId, toUserId: session.userId },
  });
  if (!transfer) throw new NotFoundError('transfer not found');
  if (transfer.status !== 'pending') {
    throw new InvalidInputError(`transfer is ${transfer.status}, not pending`);
  }
  if (transfer.expiresAt < new Date()) {
    // Lazy expiry — mark and reject.
    await unsafePrismaAdmin.ownershipTransfer.update({
      where: { id: transferId },
      data: { status: 'expired', decidedAt: new Date() },
    });
    throw new InvalidInputError('transfer has expired');
  }

  const orgOwnerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
    where: { key: 'ORG_OWNER', organizationId: null },
    select: { id: true },
  });
  const orgAdminRole = await unsafePrismaAdmin.role.findFirstOrThrow({
    where: { key: 'ORG_ADMIN', organizationId: null },
    select: { id: true },
  });

  // Single transaction for the swap. Uses unsafePrismaAdmin because we need to
  // update two memberships + the org + the transfer + bump two users'
  // sessionVersions — all in one atomic write.
  await unsafePrismaAdmin.$transaction(async (tx) => {
    // Target membership must still exist + be active.
    const toMembership = await tx.membership.findFirst({
      where: {
        userId: transfer.toUserId,
        organizationId: transfer.organizationId,
        status: 'active',
      },
      select: { id: true },
    });
    if (!toMembership) {
      throw new InvalidInputError('you are no longer a member of this organization');
    }

    // From-membership: current owner. Might have been demoted already
    // by a concurrent action — handle gracefully.
    const fromMembership = await tx.membership.findFirst({
      where: {
        userId: transfer.fromUserId,
        organizationId: transfer.organizationId,
        status: 'active',
      },
      select: { id: true },
    });

    // Promote target to ORG_OWNER.
    await tx.membership.update({
      where: { id: toMembership.id },
      data: { role: 'owner', roleId: orgOwnerRole.id },
    });

    // Demote previous owner to ORG_ADMIN (if still active).
    if (fromMembership) {
      await tx.membership.update({
        where: { id: fromMembership.id },
        // Legacy enum has no 'admin' value — leave as 'owner' during
        // Contract; role_id is authoritative post-Phase-4.
        data: { roleId: orgAdminRole.id },
      });
    }

    // Point the org at the new owner.
    await tx.organization.update({
      where: { id: transfer.organizationId },
      data: { ownerUserId: transfer.toUserId },
    });

    // Close the transfer.
    await tx.ownershipTransfer.update({
      where: { id: transferId },
      data: { status: 'accepted', decidedAt: new Date() },
    });

    // Bump both users' sessionVersions (spec §9 rule 10). Their JWTs
    // pick up the new roles within 5s and their AuthContext caches
    // rebuild with the correct permissions.
    await tx.appUser.updateMany({
      where: { id: { in: [transfer.fromUserId, transfer.toUserId] } },
      data: { sessionVersion: { increment: 1 } },
    });

    // Audit rows for both role changes.
    await tx.auditLog.create({
      data: {
        organizationId: transfer.organizationId,
        actorUserId: transfer.toUserId,
        action: 'org.ownership.accepted',
        entity: 'staff',
        entityId: transfer.toUserId,
        reason: 'ownership transfer accepted',
        meta: { transferId, fromUserId: transfer.fromUserId },
      },
    });
    if (fromMembership) {
      await tx.auditLog.create({
        data: {
          organizationId: transfer.organizationId,
          actorUserId: transfer.toUserId,
          action: 'staff.role.change',
          entity: 'staff',
          entityId: transfer.fromUserId,
          reason: 'demoted after ownership transfer',
          meta: { transferId, newRoleKey: 'ORG_ADMIN' },
        },
      });
    }
  });

  log.info('platform.ownership_transfer.accepted', {
    transferId,
    fromUserId: transfer.fromUserId,
    toUserId: transfer.toUserId,
    organizationId: transfer.organizationId,
  });
  return { ok: true };
}

export async function declineTransfer(
  session: ActiveSession,
  transferId: string,
  reason: string = 'declined by nominee',
): Promise<{ ok: true }> {
  // SEC-007 hardening: WHERE clause carries `toUserId = session.userId`
  // so non-nominees see 404, not "not for you." Same enumeration-kill
  // as acceptTransfer.
  const transfer = await unsafePrismaAdmin.ownershipTransfer.findFirst({
    where: { id: transferId, toUserId: session.userId },
  });
  if (!transfer) throw new NotFoundError('transfer not found');
  if (transfer.status !== 'pending') {
    throw new InvalidInputError(`transfer is ${transfer.status}, not pending`);
  }
  await unsafePrismaAdmin.ownershipTransfer.update({
    where: { id: transferId },
    data: { status: 'declined', decidedAt: new Date(), decidedReason: reason },
  });
  await unsafePrismaAdmin.auditLog.create({
    data: {
      organizationId: transfer.organizationId,
      actorUserId: session.userId,
      action: 'org.ownership.declined',
      entity: 'staff',
      reason,
      meta: { transferId, fromUserId: transfer.fromUserId },
    },
  });
  // Optional: notify original owner.
  log.info('platform.ownership_transfer.declined', { transferId });
  return { ok: true };
}

export async function revokeTransfer(
  session: ActiveSession,
  transferId: string,
): Promise<{ ok: true }> {
  // SEC-007 hardening: WHERE clause carries `fromUserId = session.userId`
  // so non-nominators see 404. Same enumeration-kill; only the party who
  // created the transfer can see it exists.
  const transfer = await unsafePrismaAdmin.ownershipTransfer.findFirst({
    where: { id: transferId, fromUserId: session.userId },
  });
  if (!transfer) throw new NotFoundError('transfer not found');
  if (transfer.status !== 'pending') {
    throw new InvalidInputError(`transfer is ${transfer.status}, not pending`);
  }
  await unsafePrismaAdmin.ownershipTransfer.update({
    where: { id: transferId },
    data: { status: 'revoked', decidedAt: new Date() },
  });
  log.info('platform.ownership_transfer.revoked', { transferId });
  return { ok: true };
}

/** Nominee's inbox — pending transfers addressed to `userId`. */
export async function pendingTransfersForNominee(userId: string) {
  const rows = await unsafePrismaAdmin.ownershipTransfer.findMany({
    where: { toUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
    include: {
      organization: { select: { name: true } },
      fromUser: { select: { email: true, fullName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    organizationName: r.organization.name,
    fromEmail: r.fromUser.email,
    fromName: r.fromUser.fullName,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}
