import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { listPlatformRoleHolders, assignPlatformRole } from '@/lib/platform/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/platform/roles — list everyone holding a platform role.
// Any platform role can list (audit / accountability); Assignment itself
// is gated separately below.
export async function GET() {
  return withPlatformApi('role.list', async (ctx) => {
    requirePermission(ctx, 'platform.audit.read', undefined, 'platform');
    return { holders: await listPlatformRoleHolders() };
  });
}

// POST /api/platform/roles — assign or revoke a platform role for a user
// identified by email. SUPER_ADMIN only via `platform.role.assign`.
// Body: { email: string; roleKey: 'SUPER_ADMIN'|'PLATFORM_ADMIN'|'SUPPORT_AGENT'|'BILLING_MANAGER'|null }
export async function POST(req: NextRequest) {
  return withPlatformApi('role.assign', async (ctx) => {
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    const body = (await req.json().catch(() => null)) as {
      email?: unknown; roleKey?: unknown;
    } | null;
    if (!body || typeof body.email !== 'string') {
      throw new InvalidInputError('email is required');
    }
    if (body.roleKey !== null && typeof body.roleKey !== 'string') {
      throw new InvalidInputError('roleKey must be a string or null');
    }
    return assignPlatformRole(ctx, body.email, body.roleKey as never);
  });
}
