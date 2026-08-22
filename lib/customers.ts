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

// -----------------------------------------------------------------------------
// F16-008 — bounded list loading.
//
// The patients screen used to load every customer in the organization together
// with every treatment-history row for each of them, then decrypt allergies and
// clinical notes per row — to render a left-hand list that shows a name, a
// phone number and an avatar. Cost grew with tenant size on the busiest
// clinical screen in the product.
//
// Two separations fix it:
//
//   1. The list surface gets its own DTO. No allergies, no clinical notes, no
//      insurance, no treatment history — the list does not render any of them,
//      so they are not fetched, not decrypted, and not sent.
//   2. Detail is fetched per selection from GET /api/customers/[id], which
//      already returns the full record with history and enforces the same
//      permission.
//
// Ordering is `createdAt DESC, id DESC`. The id is not decoration: createdAt is
// not unique, and a cursor on a non-unique key silently drops or repeats rows
// at the page boundary.
// -----------------------------------------------------------------------------

/** Rows per page when the caller does not ask. */
export const CUSTOMER_PAGE_DEFAULT = 50;
/** Hard ceiling. A caller asking for more gets an error, not a silent clamp. */
export const CUSTOMER_PAGE_MAX = 100;

export type CustomerListItemDto = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  joinedDate: string;
  consentAt: string | null;
  consentVersion: string | null;
  createdAt: string;
  /**
   * Whether the row carries an allergy warning — a boolean, never the text.
   *
   * The list renders a red dot for this; dropping it would remove a clinical
   * safety affordance to save bytes. Gated on the same client.read:full check
   * as the plaintext, so a contact-only caller sees `false` exactly as they
   * previously saw no dot. Decryption is now bounded by page size rather than
   * by tenant size.
   */
  hasAllergies: boolean;
};

/** Columns the list DTO needs — the projection is the enforcement. */
export const CUSTOMER_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatarUrl: true,
  joinedDate: true,
  consentAt: true,
  consentVersion: true,
  createdAt: true,
  // Ciphertext, read only to derive hasAllergies. Never serialised.
  allergies: true,
} as const;

type CustomerListRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  joinedDate: Date;
  consentAt: Date | null;
  consentVersion: string | null;
  createdAt: Date;
  allergies: string | null;
};

export function toCustomerListItemDto(
  row: CustomerListRow,
  v: CustomerVisibility,
): CustomerListItemDto {
  const full = decideFullAccess(v);
  const allergyText = full ? decryptField(row.allergies) : null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatarUrl,
    joinedDate: row.joinedDate.toISOString().slice(0, 10),
    consentAt: row.consentAt?.toISOString() ?? null,
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
    hasAllergies: !!allergyText && allergyText.trim().toLowerCase() !== 'none',
  };
}

export type CustomerPage = {
  items: CustomerListItemDto[];
  /** Opaque; pass back verbatim as `cursor`. Null when the page is the last. */
  nextCursor: string | null;
  hasMore: boolean;
};

/** `<createdAt ISO>|<uuid>` — opaque to the client, checked on the way in. */
export function encodeCustomerCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

export function decodeCustomerCursor(raw: string): { createdAt: Date; id: string } {
  const sep = raw.indexOf('|');
  if (sep < 1) throw new InvalidInputError('cursor is malformed');
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime())) throw new InvalidInputError('cursor is malformed');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new InvalidInputError('cursor is malformed');
  return { createdAt, id };
}

export function parsePageSize(raw: string | null): number {
  if (raw === null || raw === '') return CUSTOMER_PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new InvalidInputError('limit must be a positive integer');
  if (n > CUSTOMER_PAGE_MAX) {
    throw new InvalidInputError(`limit must not exceed ${CUSTOMER_PAGE_MAX}`);
  }
  return n;
}

/**
 * Prisma `where` for one page of an organization's customers.
 *
 * `organizationId` is passed explicitly even though every caller runs inside
 * withOrg() and RLS already constrains the rows. CLAUDE.md invariant 1 asks for
 * the predicate, not for a reason it could be omitted.
 */
export function buildCustomerListWhere(input: {
  organizationId: string;
  search?: string | null;
  cursor?: { createdAt: Date; id: string } | null;
}) {
  const q = (input.search ?? '').trim();
  const search =
    q.length > 0
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { phone: { contains: q } },
          ],
        }
      : {};

  // Keyset, not offset: "older than this createdAt, or the same createdAt with
  // a smaller id". Offset pagination would shift under concurrent inserts and
  // repeat or skip rows between pages.
  const after = input.cursor
    ? {
        OR: [
          { createdAt: { lt: input.cursor.createdAt } },
          { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
        ],
      }
    : {};

  return { AND: [{ organizationId: input.organizationId }, search, after] };
}

export const CUSTOMER_LIST_ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
