import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { sendPasswordResetLink } from '@/lib/platform/orgs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('user.password_reset', async (ctx) => {
    requirePermission(ctx, 'platform.user.password_reset', undefined, 'platform');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email : '';
    if (!email) throw new InvalidInputError('email is required');
    return sendPasswordResetLink(ctx, id, email);
  });
}
