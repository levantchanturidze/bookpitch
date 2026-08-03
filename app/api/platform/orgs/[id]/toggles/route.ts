import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission, loadOrgToggles, updateOrgToggles } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { requireFreshPassword } from '@/lib/platform/password-reauth';
import { prismaAdmin } from '@/lib/db';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/platform/orgs/[id]/toggles — any platform role can view a
// given org's toggle values. Uses `platform.analytics.read` (weakest
// platform perm — the same one gating /platform/*).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.toggles.get', async (ctx) => {
    requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
    const { id } = await params;
    return { toggles: await loadOrgToggles(id) };
  });
}

// PATCH — SUPER_ADMIN only (`platform.config.manage`, per seed). Toggles
// gate clinical-note visibility and front-desk PII tiers — treat any
// change as destructive-tier and require fresh password re-auth.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.toggles.set', async (ctx) => {
    requirePermission(ctx, 'platform.config.manage', undefined, 'platform');
    requireFreshPassword(ctx.userId);
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      providerFinancialReports?: unknown;
      providerClinicalNotesOthers?: unknown;
      frontdeskClientFullHistory?: unknown;
      frontdeskDiscountCeiling?: unknown;
    } | null;
    if (!body) throw new InvalidInputError('invalid body');
    const patch: Parameters<typeof updateOrgToggles>[1] = {};
    if (typeof body.providerFinancialReports === 'boolean') {
      patch.providerFinancialReports = body.providerFinancialReports;
    }
    if (typeof body.providerClinicalNotesOthers === 'boolean') {
      patch.providerClinicalNotesOthers = body.providerClinicalNotesOthers;
    }
    if (typeof body.frontdeskClientFullHistory === 'boolean') {
      patch.frontdeskClientFullHistory = body.frontdeskClientFullHistory;
    }
    if (typeof body.frontdeskDiscountCeiling === 'number' && Number.isFinite(body.frontdeskDiscountCeiling)) {
      if (body.frontdeskDiscountCeiling < 0) {
        throw new InvalidInputError('frontdeskDiscountCeiling must be >= 0');
      }
      patch.frontdeskDiscountCeiling = body.frontdeskDiscountCeiling;
    }
    if (Object.keys(patch).length === 0) {
      throw new InvalidInputError('no editable fields');
    }

    // SEC-004: audit the change. These toggles govern clinical-note
    // visibility and PII tiers — every flip is a policy-level event
    // and spec §9 rule 5 requires it in audit_log. Snapshot the
    // previous state before mutating so the meta captures both sides.
    const previous = await loadOrgToggles(id);
    const next = await updateOrgToggles(id, patch);
    await prismaAdmin.auditLog.create({
      data: {
        organizationId: id,
        actorUserId: ctx.userId,
        action: 'org.toggles.update',
        entity: 'organization',
        entityId: id,
        reason: 'platform:org.toggles.update',
        impersonationSessionId: ctx.impersonation?.sessionId ?? null,
        breakGlassSessionId: ctx.breakGlass?.sessionId ?? null,
        meta: {
          changed: Object.keys(patch),
          previous: previous as unknown as import('@prisma/client').Prisma.InputJsonValue,
          next: next as unknown as import('@prisma/client').Prisma.InputJsonValue,
        },
      },
    });
    log.info('platform.org.toggles.update', {
      orgId: id, actorUserId: ctx.userId, changed: Object.keys(patch),
    });
    return { toggles: next };
  });
}
