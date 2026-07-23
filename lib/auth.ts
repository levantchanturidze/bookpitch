import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import type { UserRole } from '@prisma/client';
import { log, newRequestId, updateRequestContext, withRequestContext } from '@/lib/logger';

export type ActiveSession = {
  userId: string;
  organizationId: string;
  role: UserRole;
  email: string;
};

/**
 * Returns the active session or `null`. Server-only.
 *
 * When the caller has a bp_active_org cookie naming a valid membership,
 * the returned org/role reflect that org instead of the JWT default.
 */
export async function getSession(): Promise<ActiveSession | null> {
  const session = await auth();
  if (!session?.user) return null;
  const base: ActiveSession = {
    userId: session.user.id,
    organizationId: session.user.organizationId,
    role: session.user.role,
    email: session.user.email,
  };
  // Dynamic import — the cookies() API only works in request scope, and
  // this module is imported by other places (auth.ts init) where it isn't.
  const { resolveActiveOrg } = await import('@/lib/org-switch');
  return resolveActiveOrg(base);
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

/**
 * Throws if the caller is not signed in. Returns the session otherwise.
 */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

/**
 * Throws ForbiddenError unless the caller's role is one of `roles`.
 */
export async function requireRole(...roles: UserRole[]): Promise<ActiveSession> {
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    throw new ForbiddenError(`Requires role: ${roles.join(', ')}`);
  }
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
  // Unknown: mark as 500 in the response we build for logging purposes; the
  // caller re-throws so the platform surfaces the stack trace.
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
