import type { Customer, TreatmentHistory } from '@prisma/client';
import { decryptField, encryptField } from '@/lib/crypto';
import { InvalidInputError } from '@/lib/auth';

// -----------------------------------------------------------------------------
// Shared types + helpers for the /api/customers layer and Server Actions.
// Keeps encryption/decryption logic in one place so callers can't forget.
// -----------------------------------------------------------------------------

export type CustomerDto = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  dob: string | null;
  gender: string | null;
  avatarUrl: string | null;
  joinedDate: string;
  // Decrypted — safe to send to authorized clients over TLS.
  allergies: string | null;
  clinicalNotes: string | null;
  consentAt: string | null;
  consentVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomerDetailDto = CustomerDto & {
  treatmentHistory: Array<{
    id: string;
    label: string;
    occurredOn: string | null;
    createdAt: string;
  }>;
};

export function toCustomerDto(row: Customer): CustomerDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    dob: row.dob ? row.dob.toISOString().slice(0, 10) : null,
    gender: row.gender,
    avatarUrl: row.avatarUrl,
    joinedDate: row.joinedDate.toISOString().slice(0, 10),
    allergies: decryptField(row.allergies),
    clinicalNotes: decryptField(row.clinicalNotes),
    consentAt: row.consentAt?.toISOString() ?? null,
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCustomerDetailDto(
  row: Customer & { treatmentHistory: TreatmentHistory[] },
): CustomerDetailDto {
  return {
    ...toCustomerDto(row),
    treatmentHistory: row.treatmentHistory.map((h) => ({
      id: h.id,
      label: h.label,
      occurredOn: h.occurredOn ? h.occurredOn.toISOString().slice(0, 10) : null,
      createdAt: h.createdAt.toISOString(),
    })),
  };
}

// -----------------------------------------------------------------------------
// Input parsing — hand-validated (no zod). Keep loose but reject obvious junk.
// -----------------------------------------------------------------------------

const CONSENT_VERSION = '1.0';

export type CustomerCreateInput = {
  name: string;
  email?: string | null;
  phone?: string | null;
  dob?: string | null; // YYYY-MM-DD
  gender?: string | null;
  avatarUrl?: string | null;
  allergies?: string | null; // plaintext — encrypted before write
  clinicalNotes?: string | null;
  consent: boolean; // required for create
};

export type CustomerUpdateInput = Partial<Omit<CustomerCreateInput, 'consent'>> & {
  consent?: boolean; // if true, refreshes consent_at + consent_version
};

function optionalString(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new InvalidInputError(`${field} must be a string`);
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

export function parseCreateInput(body: unknown): CustomerCreateInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;

  const name = optionalString(b.name, 'name');
  if (!name) throw new InvalidInputError('name is required');

  if (b.consent !== true) {
    throw new InvalidInputError('consent is required for new customer profiles');
  }

  return {
    name,
    email: optionalString(b.email, 'email'),
    phone: optionalString(b.phone, 'phone'),
    dob: optionalString(b.dob, 'dob'),
    gender: optionalString(b.gender, 'gender'),
    avatarUrl: optionalString(b.avatarUrl, 'avatarUrl'),
    allergies: optionalString(b.allergies, 'allergies'),
    clinicalNotes: optionalString(b.clinicalNotes, 'clinicalNotes'),
    consent: true,
  };
}

export function parseUpdateInput(body: unknown): CustomerUpdateInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;
  const out: CustomerUpdateInput = {};
  const name = optionalString(b.name, 'name');
  if (name !== undefined) {
    if (!name) throw new InvalidInputError('name cannot be blank');
    out.name = name;
  }
  const setIfDefined = <K extends keyof CustomerUpdateInput>(
    key: K,
    v: string | null | undefined,
  ) => {
    if (v !== undefined) (out as Record<string, unknown>)[key as string] = v;
  };
  setIfDefined('email', optionalString(b.email, 'email'));
  setIfDefined('phone', optionalString(b.phone, 'phone'));
  setIfDefined('dob', optionalString(b.dob, 'dob'));
  setIfDefined('gender', optionalString(b.gender, 'gender'));
  setIfDefined('avatarUrl', optionalString(b.avatarUrl, 'avatarUrl'));
  setIfDefined('allergies', optionalString(b.allergies, 'allergies'));
  setIfDefined('clinicalNotes', optionalString(b.clinicalNotes, 'clinicalNotes'));
  if (b.consent === true) out.consent = true;
  return out;
}

// Build the Prisma write payload for a create. Encrypts sensitive fields.
export function buildCreateData(input: CustomerCreateInput, organizationId: string) {
  return {
    organizationId,
    name: input.name,
    email: input.email ?? undefined,
    phone: input.phone ?? undefined,
    dob: input.dob ? new Date(input.dob) : undefined,
    gender: input.gender ?? undefined,
    avatarUrl: input.avatarUrl ?? undefined,
    allergies: encryptField(input.allergies ?? null),
    clinicalNotes: encryptField(input.clinicalNotes ?? null),
    consentAt: new Date(),
    consentVersion: CONSENT_VERSION,
  };
}

// Build the Prisma write payload for a patch. Only encrypts fields that
// were actually passed. Returns the list of top-level field names touched so
// the audit log can note what changed.
export function buildUpdateData(input: CustomerUpdateInput): {
  data: Record<string, unknown>;
  fields: string[];
} {
  const data: Record<string, unknown> = {};
  const fields: string[] = [];
  const set = (k: string, v: unknown) => {
    data[k] = v;
    fields.push(k);
  };
  if (input.name !== undefined) set('name', input.name);
  if (input.email !== undefined) set('email', input.email);
  if (input.phone !== undefined) set('phone', input.phone);
  if (input.dob !== undefined) set('dob', input.dob ? new Date(input.dob) : null);
  if (input.gender !== undefined) set('gender', input.gender);
  if (input.avatarUrl !== undefined) set('avatarUrl', input.avatarUrl);
  if (input.allergies !== undefined) set('allergies', encryptField(input.allergies));
  if (input.clinicalNotes !== undefined) set('clinicalNotes', encryptField(input.clinicalNotes));
  if (input.consent === true) {
    set('consentAt', new Date());
    set('consentVersion', CONSENT_VERSION);
  }
  return { data, fields };
}
