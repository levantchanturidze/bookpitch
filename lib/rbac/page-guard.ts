// -----------------------------------------------------------------------------
// P17-013 — the page-render half of the permission guard.
//
// `requirePermission` throws `ForbiddenError`. That is the right shape for a
// route handler, where `withApi` catches it and answers 403 JSON. It is the
// wrong shape for a page: nothing catches it during a server render, so Next
// treats it as an unhandled server error and answers 500. Measured 2026-09-01
// against `next start` at commit ceeb9a9 — MARKETING opening /scheduler,
// /audit and /settings each received HTTP 500 and the generic "Something went
// wrong" fallback from `app/(app)/error.tsx`.
//
// The panel that boundary was written for could never render there:
// `error.name` is stripped from errors forwarded to the client in a production
// build, so the `error.name === 'ForbiddenError'` branch was dead code in the
// only environment that mattered.
//
// The framework's answer is `forbidden()`, which throws Next's own
// authorization interrupt. Next renders the nearest `forbidden.tsx` and sets
// the status to 403. That is what this wrapper does, and it exists rather than
// changing `requirePermission` itself for one reason: API routes must keep
// answering 403 JSON. A single guard emitting an interrupt would either be
// swallowed by `withApi`'s catch — the documented way to lose the interrupt —
// or replace a JSON body with an HTML page for API callers.
//
// So the split is by caller, not by decision:
//
//   pages and layouts     requirePagePermission  → forbidden() → 403 + UI
//   route handlers        requirePermission      → ForbiddenError → 403 JSON
//   server actions        requirePermission      → ForbiddenError → caller maps
//
// The decision itself is identical: this delegates to `requirePermission`, so
// shadow mode, the `rbac.enforce_deny` log line and `RBAC_ENFORCE_MODULES` all
// behave exactly as before. Only the transport of the refusal changes.
// -----------------------------------------------------------------------------

import { forbidden } from 'next/navigation';
import { ForbiddenError } from '@/lib/auth';
import { requirePermission } from './guard';
import type { AuthContext, PermissionKey, Resource } from './types';

/**
 * Permission guard for a server component (page or non-root layout).
 *
 * Identical to `requirePermission` except that a denial becomes Next's
 * authorization interrupt instead of a thrown `ForbiddenError`, so the user
 * gets a 403 and the `forbidden.tsx` boundary rather than a 500 and the
 * generic error page.
 *
 * Must not be called from the root layout — `forbidden()` cannot interrupt
 * there (Next docs, `forbidden.md` § Good to know). No root layout in this
 * app calls a permission guard; `app/(app)/layout.tsx` only resolves context.
 *
 * Returns the context so it reads the same way as `requirePermission` at a
 * callsite. It never returns on denial: `forbidden()` throws.
 */
export function requirePagePermission(
  ctx: AuthContext,
  permission: PermissionKey | string,
  resource?: Resource,
  module: string | null = null,
): AuthContext {
  try {
    return requirePermission(ctx, permission, resource, module);
  } catch (err) {
    // Only an authorization denial becomes an interrupt. Anything else — a
    // broken context, a database failure inside `can()` — must keep its own
    // identity and reach the error boundary, not be mislabelled a 403.
    if (err instanceof ForbiddenError) forbidden();
    throw err;
  }
}
