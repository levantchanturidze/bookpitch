import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import type { UserRole } from '@prisma/client';

export type ActiveSession = {
  userId: string;
  organizationId: string;
  role: UserRole;
  email: string;
};

/**
 * Returns the active session or `null`. Server-only.
 */
export async function getSession(): Promise<ActiveSession | null> {
  const session = await auth();
  if (!session?.user) return null;
  return {
    userId: session.user.id,
    organizationId: session.user.organizationId,
    role: session.user.role,
    email: session.user.email,
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
  return handler()
    .then((body) => NextResponse.json(body))
    .catch((err) => {
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
      throw err;
    });
}
