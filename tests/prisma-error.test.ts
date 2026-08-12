/**
 * Unit probes for mapPrismaError:
 *   - P2002 unique violation with Prisma 7.x driverAdapterError meta → ConflictError + model-aware message
 *   - P2002 with legacy meta.target array (Prisma < 6) → ConflictError
 *   - P2002 unknown field → ConflictError with generic "already in use" message
 *   - P2003 FK violation → ConflictError with caller-supplied or generic message
 *   - P2025 not found → InvalidInputError
 *   - Non-Prisma error → re-thrown unchanged
 */

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { mapPrismaError } = await import('@/lib/prisma-error');

// Build a P2002 with Prisma 7.x driverAdapterError shape (what the DB driver sends).
function makeP2002v7(
  dbFields: string[],
  modelName?: string,
  constraintName?: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.9.0',
    meta: {
      ...(modelName ? { modelName } : {}),
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: constraintName
            ? `duplicate key value violates unique constraint "${constraintName}"`
            : `duplicate key value violates unique constraint "(not available)"`,
          kind: 'UniqueConstraintViolation',
          constraint: { fields: dbFields },
        },
      },
    },
  });
}

// Build a P2002 with legacy meta.target array (Prisma < 6 / mocked units).
function makeP2002legacy(target: string[], modelName?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '0.0.0',
    meta: { target, ...(modelName ? { modelName } : {}) },
  });
}

function makeP2003(fkMsg?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('FK constraint failed', {
    code: 'P2003',
    clientVersion: '7.9.0',
    meta: { field_name: 'fk_column' },
  });
}

function makeP2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record not found', {
    code: 'P2025',
    clientVersion: '7.9.0',
    meta: {},
  });
}

describe('mapPrismaError', () => {
  it('P2002 Prisma7: Location.public_slug → ConflictError with slug message', () => {
    const err = makeP2002v7(['public_slug'], 'Location', 'idx_locations_public_slug');
    expect(() => mapPrismaError(err)).toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('slug') }),
    );
  });

  it('P2002 Prisma7: AppUser.email → ConflictError with email message', () => {
    const err = makeP2002v7(['email'], 'AppUser');
    expect(() => mapPrismaError(err)).toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('email') }),
    );
  });

  it('P2002 Prisma7: unknown field → ConflictError with field name in message', () => {
    const err = makeP2002v7(['weird_field'], 'Unknown');
    expect(() => mapPrismaError(err)).toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('weirdField') }),
    );
  });

  it('P2002 legacy meta.target: Location.publicSlug → ConflictError with slug message', () => {
    const err = makeP2002legacy(['publicSlug'], 'Location');
    expect(() => mapPrismaError(err)).toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('slug') }),
    );
  });

  it('P2003 without fkMessage → ConflictError with generic FK message', () => {
    expect(() => mapPrismaError(makeP2003())).toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('referenced') }),
    );
  });

  it('P2003 with fkMessage → ConflictError with that message', () => {
    expect(() => mapPrismaError(makeP2003(), { fkMessage: 'Staff has bookings.' })).toThrow(
      expect.objectContaining({ name: 'ConflictError', message: 'Staff has bookings.' }),
    );
  });

  it('P2025 → InvalidInputError', () => {
    expect(() => mapPrismaError(makeP2025())).toThrow(
      expect.objectContaining({ name: 'InvalidInputError' }),
    );
  });

  it('non-Prisma error → re-thrown unchanged', () => {
    const plain = new Error('network timeout');
    expect(() => mapPrismaError(plain)).toThrow(plain);
  });
});
