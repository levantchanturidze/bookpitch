import type { Customer, TreatmentHistory } from '@prisma/client';
import { decryptField, encryptField } from '@/lib/crypto';
import { InvalidInputError } from '@/lib/auth';
import type { AuthContext } from '@/lib/rbac';
import { can } from '@/lib/rbac';

// -----------------------------------------------------------------------------
// Shared types + helpers for the /api/customers layer and Server Actions.
// Keeps encryption/decryption logic in one place so callers can't forget.
//
// SEC-008 (2026-08-05). Every DTO builder now takes an AuthContext so it
// can strip clinical/allergy/history fields for callers who don't hold
// `client.read:full` (or its toggle-elevated equivalent — see
// lib/rbac/can.ts::toggleGrantsPermission for the frontdeskClientFullHistory
// wire-up). Before this, the DTO returned every field to every authorized
// caller, and the three "front-desk full history / provider notes:any"
// toggles changed nothing observable.
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
  insurerName: string | null;
  insurancePolicyNumber: string | null;
  // Decrypted when the caller has client.read:full. Redacted to null
  // otherwise (SEC-008). `undefined` never appears — the field is
  // ALWAYS present in the response shape, so the client cannot infer
  // "these are hidden" vs "these were never set."
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

/**
 * The visibility decision. Callers pass either an AuthContext (production
 * path) or an explicit boolean (tests + code paths that already resolved
 * the check). No default — omission is a compile error.
 */
export type CustomerVisibility = { ctx: AuthContext } | { canReadFull: boolean };

function decideFullAccess(v: CustomerVisibility): boolean {
  if ('canReadFull' in v) return v.canReadFull;
  const org = v.ctx.activeOrganizationId ?? undefined;
  // Two independent grants cover the "see clinical fields" tier:
  //   • client.read:full — OWNER / ADMIN / BRANCH_MANAGER baseline, and
  //     FRONT_DESK when the frontdeskClientFullHistory toggle elevates.
  //   • clinical_note.read:any — PROVIDER / SENIOR_PROVIDER when the
  //     providerClinicalNotesOthers toggle elevates.
  // Both toggles land here through can()'s SEC-008 elevation branch, so
  // this one decideFullAccess() is the single enforcement point.
  return (
    can(v.ctx, 'client.read:full', { organizationId: org }) ||
    can(v.ctx, 'clinical_note.read:any', { organizationId: org })
  );
}

export function toCustomerDto(row: Customer, v: CustomerVisibility): CustomerDto {
  const full = decideFullAccess(v);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    dob: row.dob ? row.dob.toISOString().slice(0, 10) : null,
    gender: row.gender,
    avatarUrl: row.avatarUrl,
    joinedDate: row.joinedDate.toISOString().slice(0, 10),
    insurerName: row.insurerName ?? null,
    insurancePolicyNumber: row.insurancePolicyNumber ?? null,
    // SEC-008 gate. Contact-only tier sees null for both.
    allergies: full ? decryptField(row.allergies) : null,
    clinicalNotes: full ? decryptField(row.clinicalNotes) : null,
    consentAt: row.consentAt?.toISOString() ?? null,
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCustomerDetailDto(
  row: Customer & { treatmentHistory: TreatmentHistory[] },
  v: CustomerVisibility,
): CustomerDetailDto {
  const full = decideFullAccess(v);
  return {
    ...toCustomerDto(row, v),
    // Treatment history is per-visit clinical narrative — same tier as
    // allergies/notes. Contact-only tier sees an empty list rather than
    // no field at all.
    treatmentHistory: full
      ? row.treatmentHistory.map((h) => ({
          id: h.id,
          label: h.label,
          occurredOn: h.occurredOn ? h.occurredOn.toISOString().slice(0, 10) : null,
          createdAt: h.createdAt.toISOString(),
        }))
      : [],
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
  insurerName?: string | null;
  insurancePolicyNumber?: string | null;
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
  setIfDefined('insurerName', optionalString(b.insurerName, 'insurerName'));
  setIfDefined(
    'insurancePolicyNumber',
    optionalString(b.insurancePolicyNumber, 'insurancePolicyNumber'),
  );
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
  if (input.insurerName !== undefined) set('insurerName', input.insurerName);
  if (input.insurancePolicyNumber !== undefined)
    set('insurancePolicyNumber', input.insurancePolicyNumber);
  if (input.consent === true) {
    set('consentAt', new Date());
    set('consentVersion', CONSENT_VERSION);
  }
  return { data, fields };
}
