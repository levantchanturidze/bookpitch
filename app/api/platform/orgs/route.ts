import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { listOrganizations, createOrganization } from '@/lib/platform/orgs';
import { InvalidInputError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/platform/orgs — every platform role can list. SUPPORT_AGENT
// sees the same row shape (aggregate counts, no customer PII).
export async function GET() {
  return withPlatformApi('org.list', async (ctx) => {
    requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
    const orgs = await listOrganizations();
    return { orgs };
  });
}

// POST /api/platform/orgs — spec §6.1 row 1. SUPER_ADMIN + PLATFORM_ADMIN.
// Enforced via `platform.org.create`. Creates the org + first location
// atomically; if ownerEmail is supplied, either promotes an existing user
// or sends an invitation link.
export async function POST(req: NextRequest) {
  return withPlatformApi('org.create', async (ctx) => {
    requirePermission(ctx, 'platform.org.create', undefined, 'platform');
    const body = (await req.json().catch(() => null)) as {
      name?: unknown;
      vertical?: unknown;
      locationName?: unknown;
      locationType?: unknown;
      ownerEmail?: unknown;
    } | null;
    if (!body || typeof body.name !== 'string') {
      throw new InvalidInputError('name is required');
    }
    return createOrganization(ctx, {
      name: body.name,
      vertical: (typeof body.vertical === 'string' ? body.vertical : null) as
        'clinic' | 'salon' | 'fitness' | 'mixed' | null,
      locationName: typeof body.locationName === 'string' ? body.locationName : undefined,
      locationType: (typeof body.locationType === 'string' ? body.locationType : undefined) as
        'clinic' | 'salon' | undefined,
      ownerEmail: typeof body.ownerEmail === 'string' ? body.ownerEmail : null,
    });
  });
}
