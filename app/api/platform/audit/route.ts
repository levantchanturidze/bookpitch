import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { queryPlatformAudit } from '@/lib/platform/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/platform/audit?actor=&org=&action=&from=&to=&limit=
//
// SUPPORT_AGENT sees the same rows with PII masked (spec §6.1 👁️).
// Mask decision is based on the caller's platform role key — all
// grantees of `platform.audit.read` reach here, but only SUPPORT_AGENT
// gets the redacted projection.
export async function GET(req: NextRequest) {
  return withPlatformApi('audit.query', async (ctx) => {
    requirePermission(ctx, 'platform.audit.read', undefined, 'platform');

    // The caller's platform role key controls masking. Read from the
    // context's platform permissions to detect SUPPORT_AGENT — its
    // platform perm set is a strict subset of SUPER/PLATFORM_ADMIN.
    // Simpler: fetch the role key from prisma using ctx.userId. Cached
    // via the 30s AuthContext cache — cheap enough to inline.
    const { unsafePrismaAdmin } = await import('@/lib/db');
    const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { platformRole: { select: { key: true } } },
    });
    const maskPii = user.platformRole?.key === 'SUPPORT_AGENT';

    const url = new URL(req.url);
    const s = (k: string) => {
      const v = url.searchParams.get(k);
      return v && v.length ? v : null;
    };
    const rows = await queryPlatformAudit({
      actorUserId: s('actor'),
      organizationId: s('org'),
      action: s('action'),
      fromDate: s('from') ? new Date(s('from')!) : null,
      toDate: s('to') ? new Date(s('to')!) : null,
      limit: Number(s('limit') ?? 200),
    }, { maskPii });
    return { rows };
  });
}
