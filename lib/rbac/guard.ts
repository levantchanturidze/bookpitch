// -----------------------------------------------------------------------------
// RBAC Phase 4 — server-side guard with shadow + enforcing modes.
//
// Usage from a route handler / server action:
//
//   const ctx = await requireAuthContext();
//   requirePermission(ctx, 'booking.update', { organizationId, branchId }, 'appointments');
//
// The last argument is the module key. Every guarded route passes one, so the
// `RBAC_ENFORCE_MODULES` env var can narrow enforcement per module. A change
// takes effect on the next deployment.
//
// Modes:
//   • enforcing — throws `ForbiddenError` on deny (mapped to 403 by
//     withApi). The default, and the answer to anything unexpected.
//   • shadow — `can()` runs, denials get logged as `rbac.shadow_deny`, the
//     request is allowed through. Never throws. It removes authorization
//     inside a tenant for every shadowed module (RLS still separates
//     tenants), so it is a last resort, never a routine rollback.
//
// `RBAC_ENFORCE_MODULES` fails closed (CLAUDE.md invariant 2):
//   • unset, empty or '*' → enforcing (all modules). Until 2026-11-03 unset
//     and empty meant shadow, and with the variable unset MARKETING reached
//     /scheduler (e2e/journeys/forbidden-access.spec.ts).
//   • 'shadow'            → shadow for every module except 'platform'
//   • 'admin,customers'   → enforcing for the listed modules, shadow for the
//     other known modules except 'platform'
//   • anything else (an unknown module, '*' inside a list, quotes, other
//     casing, an empty entry) → enforcing (all modules), and
//     `rbac.enforce_modules_invalid` is logged
// 'platform' is always enforced: platform routes have no authorization layer
// but this one, so shadowing them would let any signed-in user assign
// platform roles. A caller that names no module, or a module not in
// RBAC_MODULES, is enforced whatever the list says. A reduced mode logs
// `rbac.enforcement_reduced` (error level) once per value.
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
 * The module keys guarded callers pass. tests/rbac-enforce-default.test.ts
 * fails if a call site uses a key missing from this set.
 */
export const RBAC_MODULES: ReadonlySet<string> = new Set([
  'admin',
  'analytics',
  'appointments',
  'assistant',
  'audit',
  'billing',
  'customers',
  'dev',
  'insurance',
  'invitations',
  'payments',
  'platform',
  'reminders',
  'settings',
  'waitlist',
]);

/** Never shadowed: platform routes have no authorization layer but this one. */
const ALWAYS_ENFORCED: ReadonlySet<string> = new Set(['platform']);

type EnforcementMode =
  { kind: 'all' } | { kind: 'shadow' } | { kind: 'list'; modules: ReadonlySet<string> };

let parsedMode: { raw: string; mode: EnforcementMode } | null = null;

/** Reads RBAC_ENFORCE_MODULES, failing closed on anything unexpected. */
function enforcementMode(): EnforcementMode {
  const raw = (process.env.RBAC_ENFORCE_MODULES ?? '').trim();
  if (parsedMode && parsedMode.raw === raw) return parsedMode.mode;
  let mode: EnforcementMode;
  if (raw === '' || raw === '*') {
    mode = { kind: 'all' };
  } else if (raw === 'shadow') {
    mode = { kind: 'shadow' };
    log.error('rbac.enforcement_reduced', { mode: 'shadow', alwaysEnforced: [...ALWAYS_ENFORCED] });
  } else {
    const entries = raw.split(',').map((s) => s.trim());
    const unrecognised = entries.filter((s) => !RBAC_MODULES.has(s)).length;
    if (unrecognised > 0) {
      mode = { kind: 'all' };
      log.error('rbac.enforce_modules_invalid', {
        unrecognisedEntries: unrecognised,
        enforcing: 'all',
      });
    } else {
      mode = { kind: 'list', modules: new Set(entries) };
      log.error('rbac.enforcement_reduced', {
        mode: 'list',
        enforced: [...new Set(entries)].sort(),
      });
    }
  }
  parsedMode = { raw, mode };
  return mode;
}

/** Test hook: forget the parsed value, so its log line is emitted again. */
export function __resetEnforcementMode(): void {
  parsedMode = null;
}

/**
 * Enforcement decision for a module key.
 * Exported for tests and for the shadow-mode instrumentation.
 *
 * Fails closed: only `shadow`, or a module list that does not name `module`,
 * turns enforcement off, and never for 'platform', for a caller that names no
 * module, or for a module outside RBAC_MODULES.
 */
export function isEnforcing(module: string | null | undefined): boolean {
  const mode = enforcementMode();
  if (mode.kind === 'all') return true;
  if (!module || ALWAYS_ENFORCED.has(module) || !RBAC_MODULES.has(module)) return true;
  if (mode.kind === 'shadow') return false;
  return mode.modules.has(module);
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
