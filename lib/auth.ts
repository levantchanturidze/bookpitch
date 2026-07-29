import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { log, newRequestId, updateRequestContext, withRequestContext } from '@/lib/logger';
import type { AuthContext } from '@/lib/rbac';

/**
 * Small, everywhere-passable auth snapshot. Post-Phase-4 this is the shape
 * downstream helpers (writeAudit, admin.ts, analytics.ts, invitations.ts,
 * billing/service.ts, …) accept as `session`.
 *
 * `role` was removed in Phase 4 — callers that need role-based logic must
 * use `AuthContext` (from `requireAuthContext()`) and `can()` from
 * `@/lib/rbac`. `membershipId` is required because Phase 3's forced
 * re-auth migration ensures every live JWT carries it.
 */
export type ActiveSession = {
  userId: string;
  email: string;
  organizationId: string;
  // Phase 4: populated by getSession() and ctxToSession(). Left optional at
  // the type level so integration tests that build ActiveSession literals
  // for direct service-layer calls don't need to fabricate a synthetic
  // membershipId. Every production caller has them populated because
  // getSession() returns null when the JWT is missing them.
  membershipId?: string;
  platformRoleId?: string | null;
};

/**
 * Returns the active session or `null`. Server-only.
 *
 * Reads the JWT's canonical Phase 3 claims (`activeOrganizationId`,
 * `membershipId`, `platformRoleId`). Sessions without `membershipId` (a
 * broken or ancient token that survived the force-reauth migration)
 * return null so callers get 401 rather than a half-formed session.
 */
export async function getSession(): Promise<ActiveSession | null> {
  const session = await auth();
  if (!session?.user) return null;
  const orgId = session.user.activeOrganizationId ?? null;
  const memId = session.user.membershipId ?? null;
  if (!orgId || !memId) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    organizationId: orgId,
    membershipId: memId,
    platformRoleId: session.user.platformRoleId ?? null,
  };
}

/**
 * Adapter for callers that consume `ActiveSession` but hold an
 * `AuthContext`. Bridges the two shapes without a second DB round-trip.
 * Throws if the ctx is platform-only (no active org) — those callers
 * shouldn't be reaching org-plane helpers.
 */
export function ctxToSession(ctx: AuthContext): ActiveSession {
  if (!ctx.activeOrganizationId || !ctx.membershipId) {
    throw new Error('ctxToSession: platform-only AuthContext has no org session');
  }
  return {
    userId: ctx.userId,
    email: ctx.email,
    organizationId: ctx.activeOrganizationId,
    membershipId: ctx.membershipId,
    platformRoleId: null, // ctx carries a role, not an id; caller can re-fetch if needed
  };
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Thrown by input parsers; mapped to 400 by withApi. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/** Thrown when the DB double-booking constraint fires; mapped to 409. */
export class SlotTakenError extends Error {
  constructor() {
    super('slot_taken');
    this.name = 'SlotTakenError';
  }
}

/** Thrown for FK-guard failures (deleting a location with staff, etc.); 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Thrown when a route can't find the resource; mapped to 404 by withApi. */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Throws if the caller is not signed in. Returns the session otherwise.
 * Used by routes that need a session but no permission check (session-only
 * endpoints: notifications, session-switch, push subscribe).
 */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

/**
 * Route Handler wrapper: turns thrown auth errors into 401/403 responses so
 * routes don't need repetitive try/catch. Any other error is re-thrown.
 */
export function withApi<T>(handler: () => Promise<T>): Promise<NextResponse> {
  const requestId = newRequestId();
  return withRequestContext({ requestId }, async () => {
    const startedAt = Date.now();
    try {
      const session = await getSession().catch(() => null);
      if (session) {
        updateRequestContext({ orgId: session.organizationId, actorUserId: session.userId });
      }
      const body = await handler();
      const res = NextResponse.json(body);
      res.headers.set('x-request-id', requestId);
      const durationMs = Date.now() - startedAt;
      // Latency budget: warn at 1s, error at 3s. Adjust via env.
      const warnMs = Number(process.env.LATENCY_WARN_MS ?? 1000);
      const errorMs = Number(process.env.LATENCY_ERROR_MS ?? 3000);
      if (durationMs >= errorMs) log.error('api.slow', { durationMs, status: 200 });
      else if (durationMs >= warnMs) log.warn('api.slow', { durationMs, status: 200 });
      else log.info('api', { durationMs, status: 200 });
      return res;
    } catch (err) {
      const res = mapError(err);
      res.headers.set('x-request-id', requestId);
      if (res.status >= 500) {
        log.error('api', {
          durationMs: Date.now() - startedAt,
          status: res.status,
          error: (err as Error).message,
        });
      } else {
        log.warn('api', {
          durationMs: Date.now() - startedAt,
          status: res.status,
        });
      }
      if (res.status >= 500) throw err;
      return res;
    }
  });
}

/**
 * Same guarantees as `withApi`, but for routes whose handler returns a
 * bespoke Response (CSV, JSON attachment, file stream, …) instead of a
 * plain JSON body. The success path passes the Response through
 * untouched; the error path runs the same `mapError` so thrown
 * NotFoundError/ForbiddenError/InvalidInputError/etc. become the same
 * 4xx JSON payloads any other route would produce.
 */
export function withApiRaw(handler: () => Promise<Response>): Promise<Response> {
  const requestId = newRequestId();
  return withRequestContext({ requestId }, async () => {
    const startedAt = Date.now();
    try {
      const session = await getSession().catch(() => null);
      if (session) {
        updateRequestContext({ orgId: session.organizationId, actorUserId: session.userId });
      }
      const res = await handler();
      res.headers.set('x-request-id', requestId);
      const durationMs = Date.now() - startedAt;
      const warnMs = Number(process.env.LATENCY_WARN_MS ?? 1000);
      const errorMs = Number(process.env.LATENCY_ERROR_MS ?? 3000);
      const status = res.status;
      if (durationMs >= errorMs) log.error('api.slow', { durationMs, status });
      else if (durationMs >= warnMs) log.warn('api.slow', { durationMs, status });
      else log.info('api', { durationMs, status });
      return res;
    } catch (err) {
      const res = mapError(err);
      res.headers.set('x-request-id', requestId);
      if (res.status >= 500) {
        log.error('api', {
          durationMs: Date.now() - startedAt,
          status: res.status,
          error: (err as Error).message,
        });
      } else {
        log.warn('api', {
          durationMs: Date.now() - startedAt,
          status: res.status,
        });
      }
      if (res.status >= 500) throw err;
      return res;
    }
  });
}

function mapError(err: unknown): NextResponse {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof InvalidInputError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof SlotTakenError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  // Unknown: mark as 500 in the response we build for logging purposes; the
  // caller re-throws so the platform surfaces the stack trace.
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
