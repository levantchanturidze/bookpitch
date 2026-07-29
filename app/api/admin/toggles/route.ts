import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission, loadOrgToggles, updateOrgToggles, type OrgToggles } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/admin/toggles — read the org's current toggle values.
// Requires org.settings.update:org (owner-only by default).
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'org.settings.update:org', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const toggles = await loadOrgToggles(ctx.activeOrganizationId!);
    return { toggles };
  });
}

// PATCH /api/admin/toggles  { ...partial }
// Owner-facing setter. Callers omit unchanged fields.
export async function PATCH(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'org.settings.update:org', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const body = (await req.json().catch(() => ({}))) as Partial<Record<keyof OrgToggles, unknown>>;
    const patch: Partial<OrgToggles> = {};
    // Type-narrow one field at a time. Reject anything that isn't a
    // primitive we expect — spec §6.2 toggles are all boolean or number.
    if ('providerFinancialReports'    in body) patch.providerFinancialReports    = coerceBool(body.providerFinancialReports);
    if ('providerClinicalNotesOthers' in body) patch.providerClinicalNotesOthers = coerceBool(body.providerClinicalNotesOthers);
    if ('frontdeskClientFullHistory'  in body) patch.frontdeskClientFullHistory  = coerceBool(body.frontdeskClientFullHistory);
    if ('frontdeskDiscountCeiling'    in body) patch.frontdeskDiscountCeiling    = coerceNum(body.frontdeskDiscountCeiling);
    const toggles = await updateOrgToggles(ctx.activeOrganizationId!, patch);
    return { toggles };
  });
}

function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  throw new InvalidInputError('toggle values must be boolean');
}
function coerceNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  throw new InvalidInputError('frontdeskDiscountCeiling must be a non-negative number');
}
