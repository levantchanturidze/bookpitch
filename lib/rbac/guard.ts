// -----------------------------------------------------------------------------
// RBAC Phase 4 — server-side guard with shadow + enforcing modes.
//
// Usage from a route handler / server action:
//
//   const ctx = await requireAuthContext();
//   requirePermission(ctx, 'booking.update', { organizationId, branchId }, 'appointments');
//
// The last argument is the module key. Every guarded route passes one, so the
// `RBAC_ENFORCE_MODULES` env var can narrow enforcement per module without a
// redeploy.
//
// Modes:
//   • enforcing — throws `ForbiddenError` on deny (mapped to 403 by
//     withApi). The default: an unset or empty variable enforces.
//   • shadow — `can()` runs, denials get logged as `rbac.shadow_deny`, the
//     request is allowed through. Only on explicit request, for a canary
//     window against real traffic. Never throws.
//
// `RBAC_ENFORCE_MODULES`:
//   • unset, empty or '*' → enforcing (all modules). Fails closed (CLAUDE.md
//     invariant 2): a missing variable must never switch the guards off.
//     Until 2026-11-03 it did, and with the variable unset MARKETING reached
//     /scheduler (see e2e/journeys/forbidden-access.spec.ts).
//   • 'shadow'            → shadow (all modules), deliberately
//   • 'admin,customers'   → enforcing for these two, shadow for the other
//     named modules; a caller that names no module is enforced
// -----------------------------------------------------------------------------

import { auth } from '@/auth';
import { UnauthenticatedError, ForbiddenError } from '@/lib/auth';
import { log } from '@/lib/logger';
import { buildAuthContext } from './context';
import { can } from './can';
import type { AuthContext, PermissionKey, Resource } from './types';

/**
 * Read the JWT, resolve the AuthContext, throw if the caller isn't signed
 * in. Returns the built context (never null on success — null indicates a
 * broken session, which is a 401 not a 403).
 *
 * Patches ctx.authSessionId from the JWT's authSessionId claim so that
 * requireFreshPassword can bind reauth grants to the specific login session.
 */
export async function requireAuthContext(): Promise<AuthContext> {
  const session = await auth();
  const jwt = session as unknown as {
    user?: { id?: string; membershipId?: string | null; authSessionId?: string };
  } | null;
  const userId = jwt?.user?.id;
  if (!userId) throw new UnauthenticatedError();
  const membershipId = jwt.user?.membershipId ?? null;
  const authSessionId = jwt.user?.authSessionId ?? '';
  const ctx = await buildAuthContext(userId, membershipId);
  if (!ctx) throw new UnauthenticatedError();
  // Return a new object with the session-specific authSessionId. The cached
  // ctx has authSessionId='' because buildAuthContext doesn't have JWT access.
  return authSessionId ? { ...ctx, authSessionId } : ctx;
}

/**
 * Enforcement decision for a module key.
 * Exported for tests and for the shadow-mode instrumentation.
 *
 * Fails closed: only the explicit value `shadow`, or a module list that does
 * not name `module`, turns enforcement off. Unset, empty and `*` enforce.
 */
export function isEnforcing(module: string | null | undefined): boolean {
  const raw = (process.env.RBAC_ENFORCE_MODULES ?? '').trim();
  if (raw === '' || raw === '*') return true; // the default: enforce all
  if (raw === 'shadow') return false; // shadow everywhere, only on request
  if (!module) return true; // a caller that names no module is never exempt
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return set.has(module);
}

/**
 * Throws ForbiddenError if `can(ctx, permission, resource)` returns false
 * AND the module is in enforcing mode.
 *
 * In shadow mode, logs `rbac.shadow_deny` and returns the ctx unchanged.
 * Callers should not branch on the return value to skip work — the guard
 * is either a permission decision or a no-op logging point.
 *
 * `module` is the audit-doc key ("admin", "customers", "appointments", …)
 * that the `RBAC_ENFORCE_MODULES` env var toggles. Pass `null` only for
 * ad-hoc probes (tests); production callers should always supply one so
 * the rollout can be sliced. A `null` module is enforced under a module
 * list: it cannot be exempted by a name it never gave.
 */
export function requirePermission(
  ctx: AuthContext,
  permission: PermissionKey | string,
  resource?: Resource,
  module: string | null = null,
): AuthContext {
  const allow = can(ctx, permission, resource);
  if (allow) return ctx;

  const meta = {
    permission: String(permission),
    module,
    userId: ctx.userId,
    membershipId: ctx.membershipId,
    activeOrganizationId: ctx.activeOrganizationId,
    roleKey: ctx.roleKey,
    resource,
  };

  if (isEnforcing(module)) {
    log.warn('rbac.enforce_deny', meta);
    throw new ForbiddenError(`missing permission: ${String(permission)}`);
  }
  log.warn('rbac.shadow_deny', meta);
  return ctx;
}
