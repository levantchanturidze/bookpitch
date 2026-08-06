// -----------------------------------------------------------------------------
// RBAC Phase 6 — spec §9 rule 1: every organization keeps ≥1 active
// ORG_OWNER at all times.
//
// Called from any code path that would demote or remove the last owner
// membership: updateMemberRole, removeMember, ownership transfer accept.
// The check counts ACTIVE ORG_OWNER rows other than the one being
// mutated; a count of zero means the mutation would leave the org
// ownerless.
//
// Runs INSIDE the caller's tx (withOrg or a raw unsafePrismaAdmin transaction)
// so the count and the mutation both see the same snapshot.
// -----------------------------------------------------------------------------

import { InvalidInputError } from '@/lib/auth';
import type { Prisma, PrismaClient } from '@prisma/client';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Throws if `membershipId` currently holds an ORG_OWNER role AND
 * removing / demoting it would leave zero active ORG_OWNER memberships
 * in the org. Callers pass an open tx so the check + write are atomic.
 *
 * Returns silently in every other case:
 *   • The membership isn't ORG_OWNER — mutation is safe by definition.
 *   • Another active ORG_OWNER exists — mutation is safe.
 */
export async function assertNotLastOwner(
  tx: TxClient,
  organizationId: string,
  membershipId: string,
): Promise<void> {
  // Look up the target membership's role. If it isn't ORG_OWNER, nothing
  // to check.
  const target = await tx.membership.findUnique({
    where: { id: membershipId },
    select: { roleRef: { select: { key: true } } },
  });
  if (target?.roleRef?.key !== 'ORG_OWNER') return;

  // Count active ORG_OWNER memberships in the org EXCLUDING this one.
  // The Prisma count query targets the roles.key via nested where.
  const others = await tx.membership.count({
    where: {
      organizationId,
      id: { not: membershipId },
      status: 'active',
      roleRef: { key: 'ORG_OWNER', organizationId: null },
    },
  });
  if (others === 0) {
    throw new InvalidInputError('org must keep at least one active ORG_OWNER (spec §9 rule 1)');
  }
}

/**
 * Throws if the org has no `owner_user_id` pointer set. An org in this
 * state is partially provisioned — membership and billing mutations must
 * not proceed until an owner is designated via the platform admin panel.
 *
 * Only reachable in practice via `createOrganization` where `ownerEmail`
 * is omitted. The guard makes the invariant real at runtime rather than
 * only at seed time.
 */
export async function assertOrgOwnerSet(tx: TxClient, organizationId: string): Promise<void> {
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { ownerUserId: true },
  });
  if (!org?.ownerUserId) {
    throw new InvalidInputError(
      'this organization has no designated owner — assign one in the platform admin panel before managing memberships or billing',
    );
  }
}

/** Signature helper so callers can type their `tx` param loosely. */
export type LastOwnerTx = Prisma.TransactionClient;
