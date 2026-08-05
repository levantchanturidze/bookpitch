// -----------------------------------------------------------------------------
// RBAC Phase 6 — per-organization policy toggles (spec §6.2 ⚙️ cells).
//
// Storage: uses `organizations.features` JSONB. Toggle keys namespaced
// as `toggle.<name>` so a future feature-flag layer sharing the same
// column stays a rename, not a data migration.
//
// Access:
//   • loadOrgToggles(orgId) — 30s in-memory cache. Called once per
//     AuthContext build.
//   • ctx.orgToggles carries the parsed shape; can() consults specific
//     fields for the three gated permissions (§6.2 matrix).
//
// The fourth toggle (`frontdesk.discount_ceiling`) is numeric and enforced
// at the payments layer, not in can() — a scope check is not the right
// primitive for a currency threshold.
// -----------------------------------------------------------------------------

import { withoutRls } from '@/lib/db';

export type OrgToggles = {
  /**
   * When true, PROVIDER can pass can(ctx, 'report.financial:org', ...).
   * Default false: spec §6.2 default is that providers cannot see org
   * financial reports.
   */
  providerFinancialReports: boolean;
  /**
   * When true, PROVIDER can pass can(ctx, 'clinical_note.read:any', ...).
   * Default false: providers see only their own clinical notes (privacy).
   */
  providerClinicalNotesOthers: boolean;
  /**
   * When true, FRONT_DESK can pass can(ctx, 'client.read:full', ...).
   * Default false: front-desk sees name + contact only, not full history.
   */
  frontdeskClientFullHistory: boolean;
  /**
   * Front-desk discount ceiling (currency units, e.g. cents or GEL). A
   * discount above this cap is refused by lib/payments/service.ts.
   * Default 0 — no discretionary discount for front-desk without an
   * explicit per-org opt-in.
   */
  frontdeskDiscountCeiling: number;
};

export const DEFAULT_TOGGLES: OrgToggles = {
  providerFinancialReports: false,
  providerClinicalNotesOthers: false,
  frontdeskClientFullHistory: false,
  frontdeskDiscountCeiling: 0,
};

// The JSON keys stored under organizations.features. Namespaced so a
// future migration to a dedicated table stays a rename.
const KEY = {
  providerFinancialReports:    'toggle.provider.financial_reports',
  providerClinicalNotesOthers: 'toggle.provider.clinical_notes_others',
  frontdeskClientFullHistory:  'toggle.frontdesk.client_full_history',
  frontdeskDiscountCeiling:    'toggle.frontdesk.discount_ceiling',
} as const;

const TTL_MS = 30_000;
const cache = new Map<string, { toggles: OrgToggles; at: number }>();

function parseToggles(raw: unknown): OrgToggles {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof typeof KEY, fallback: boolean): boolean => {
    const v = src[KEY[k]];
    return typeof v === 'boolean' ? v : fallback;
  };
  const num = (k: keyof typeof KEY, fallback: number): number => {
    const v = src[KEY[k]];
    return typeof v === 'number' && v >= 0 ? v : fallback;
  };
  return {
    providerFinancialReports:    bool('providerFinancialReports',    DEFAULT_TOGGLES.providerFinancialReports),
    providerClinicalNotesOthers: bool('providerClinicalNotesOthers', DEFAULT_TOGGLES.providerClinicalNotesOthers),
    frontdeskClientFullHistory:  bool('frontdeskClientFullHistory',  DEFAULT_TOGGLES.frontdeskClientFullHistory),
    frontdeskDiscountCeiling:    num ('frontdeskDiscountCeiling',    DEFAULT_TOGGLES.frontdeskDiscountCeiling),
  };
}

export async function loadOrgToggles(orgId: string | null): Promise<OrgToggles> {
  if (!orgId) return DEFAULT_TOGGLES;
  const hit = cache.get(orgId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.toggles;
  const row = await withoutRls((tx) =>
    tx.organization.findUnique({ where: { id: orgId }, select: { features: true } }),
  );
  const toggles = parseToggles(row?.features);
  cache.set(orgId, { toggles, at: now });
  return toggles;
}

/**
 * Owner-facing setter. Writes the specified subset of toggles into the
 * `features` JSONB, preserving any other keys already there.
 * Invalidates the cache entry for the org so the next request rebuilds.
 */
export async function updateOrgToggles(
  orgId: string,
  patch: Partial<OrgToggles>,
): Promise<OrgToggles> {
  const row = await withoutRls((tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: orgId }, select: { features: true },
    }),
  );
  const current = (row.features ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  if (patch.providerFinancialReports    !== undefined) next[KEY.providerFinancialReports]    = patch.providerFinancialReports;
  if (patch.providerClinicalNotesOthers !== undefined) next[KEY.providerClinicalNotesOthers] = patch.providerClinicalNotesOthers;
  if (patch.frontdeskClientFullHistory  !== undefined) next[KEY.frontdeskClientFullHistory]  = patch.frontdeskClientFullHistory;
  if (patch.frontdeskDiscountCeiling    !== undefined) next[KEY.frontdeskDiscountCeiling]    = patch.frontdeskDiscountCeiling;

  await withoutRls((tx) =>
    tx.organization.update({
      where: { id: orgId },
      data: { features: next as import('@prisma/client').Prisma.InputJsonValue },
    }),
  );
  cache.delete(orgId);
  return parseToggles(next);
}

/** Test-only cache flush. */
export function __clearOrgTogglesCache(): void {
  cache.clear();
}
