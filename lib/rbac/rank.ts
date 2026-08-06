// -----------------------------------------------------------------------------
// RBAC Phase 3 — role management: rank + lattice.
//
// Two guards, both must pass (spec §4.2, §9 rules 2+3):
//   1. Rank: actor.rank > target.rank. Blocks self-promotion and
//      grants-at-or-above.
//   2. Lattice: an explicit role_can_manage edge. Blocks peer roles
//      (FRONT_DESK ↔ PROVIDER, both rank 40) from managing each other.
//
// Rank alone is insufficient: it can't distinguish peer roles that share
// a rank but operate in different domains. Lattice alone is insufficient:
// a data-entry error that added an edge upward would silently grant
// escalation. Both together = defense in depth.
//
// SUPER_ADMIN's rank ceiling: nothing in the org plane exceeds SUPER_ADMIN's
// rank, but SUPER_ADMIN reaching client PII goes through break-glass
// (spec §7.2), which is a Phase 5 concern. In Phase 3, SUPER_ADMIN
// canManageRoleAssignment returns true for every role that has an edge
// from SUPER_ADMIN in the seeded lattice.
// -----------------------------------------------------------------------------

import { unsafePrismaAdmin } from '@/lib/db';
import type { AuthContext } from './types';

/**
 * Can `actor` grant, edit, or revoke a membership at role `targetRoleKey`?
 *
 * Consulted by admin flows in Phase 6. Not consulted by can() — this is
 * a policy layer above can(), because role management is meta.
 *
 * Returns false when the actor has no active org membership.
 */
export async function canManageRoleAssignment(
  actor: AuthContext,
  targetRoleKey: string,
): Promise<boolean> {
  if (!actor.roleKey) return false;

  // Look up both roles in one round trip. System roles have organization_id
  // IS NULL; custom roles are org-scoped. For MVP we only manage system roles;
  // Phase 6 will extend for custom.
  const roles = await unsafePrismaAdmin.role.findMany({
    where: {
      OR: [{ key: actor.roleKey }, { key: targetRoleKey }],
      organizationId: null,
    },
    select: { id: true, key: true, rank: true },
  });
  const actorRole = roles.find((r) => r.key === actor.roleKey);
  const targetRole = roles.find((r) => r.key === targetRoleKey);
  if (!actorRole || !targetRole) return false;

  // Guard 1: numeric rank. Strict >, not >=, to block same-rank peer moves.
  if (actorRole.rank <= targetRole.rank) return false;

  // Guard 2: explicit lattice edge.
  const edge = await unsafePrismaAdmin.roleCanManage.findFirst({
    where: { parentRoleId: actorRole.id, childRoleId: targetRole.id },
    select: { parentRoleId: true },
  });
  return edge !== null;
}
