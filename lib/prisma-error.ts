import { Prisma } from '@prisma/client';
import { ConflictError, InvalidInputError } from '@/lib/auth';

// Map "ModelName.camelCaseField" or DB constraint name → user-facing conflict message.
// When i18n lands, replace string values with locale-keyed lookup calls.
//
// Two key forms are needed because Prisma's NOBYPASSRLS client (prismaApp) does
// not receive constraint.fields from the driver adapter — only the DB constraint
// name from the originalMessage. The superuser client (unsafePrismaAdmin) provides
// both. Both forms are keyed so either path hits the right message.
const P2002_MESSAGES: Record<string, string> = {
  // Qualified field names (Prisma 7+ superuser path, constraint.fields available)
  'Location.publicSlug': 'That URL slug is already taken — choose a different one.',
  'AppUser.email': 'An account with that email address already exists.',
  // DB constraint names (fallback: NOBYPASSRLS role, originalMessage only)
  'idx_locations_public_slug': 'That URL slug is already taken — choose a different one.',
  'app_users_email_key': 'An account with that email address already exists.',
};

// Prisma 7.x nests constraint details inside driverAdapterError.
type DriverAdapterCause = {
  constraint?: { fields?: string[] };
  originalMessage?: string;
};
type DriverAdapterError = { cause?: DriverAdapterCause };

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function p2002Fields(err: Prisma.PrismaClientKnownRequestError): string[] {
  const driverErr = err.meta?.driverAdapterError as DriverAdapterError | undefined;
  const dbFields = driverErr?.cause?.constraint?.fields ?? [];
  const camelFields = dbFields.map(snakeToCamel);

  // Older Prisma versions (< 6) report meta.target directly.
  const raw = err.meta?.target;
  const legacyFields: string[] = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
    ? [raw]
    : [];

  return [...new Set([...camelFields, ...legacyFields])];
}

function p2002Message(err: Prisma.PrismaClientKnownRequestError): string {
  const model = typeof err.meta?.modelName === 'string' ? err.meta.modelName : '';
  const fields = p2002Fields(err);

  for (const field of fields) {
    const qualified = model ? `${model}.${field}` : '';
    if (qualified && P2002_MESSAGES[qualified]) return P2002_MESSAGES[qualified];
    if (P2002_MESSAGES[field]) return P2002_MESSAGES[field];
  }

  // Last resort: extract constraint name from the driver error message.
  const driverErr = err.meta?.driverAdapterError as DriverAdapterError | undefined;
  const origMsg = driverErr?.cause?.originalMessage ?? '';
  const constraintName = origMsg.match(/constraint "([^"]+)"/)?.[1] ?? '';
  if (constraintName && P2002_MESSAGES[constraintName]) return P2002_MESSAGES[constraintName];

  const label = fields.length ? fields.join(', ') : 'value';
  return `That ${label} is already in use.`;
}

/**
 * Translates known Prisma constraint errors into ConflictError / InvalidInputError.
 * Always re-throws — callers use it as:
 *   try { await tx.model.op(...) } catch (e) { mapPrismaError(e) }
 *
 * Codes handled:
 *   P2002 — unique constraint → ConflictError (field-specific message)
 *   P2003 — FK constraint     → ConflictError (caller supplies context via fkMessage)
 *   P2025 — record not found  → InvalidInputError
 */
export function mapPrismaError(err: unknown, { fkMessage }: { fkMessage?: string } = {}): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        throw new ConflictError(p2002Message(err));
      case 'P2003':
        throw new ConflictError(
          fkMessage ?? 'Cannot complete — this record is referenced by other data.',
        );
      case 'P2025':
        throw new InvalidInputError('Record not found.');
    }
  }
  throw err;
}
