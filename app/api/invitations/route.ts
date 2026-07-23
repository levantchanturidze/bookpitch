import type { NextRequest } from 'next/server';
import { requireRole, withApi } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { createInvitation } from '@/lib/invitations';
import type { UserRole } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/invitations — owner only, pending invitations for this org.
export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    const rows = await withOrg(session.organizationId, (tx) =>
      tx.invitation.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    );
    return { invitations: rows };
  });
}

// POST /api/invitations { email, role } — owner only.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const body = (await req.json().catch(() => null)) as {
      email?: unknown;
      role?: unknown;
    } | null;
    const email = typeof body?.email === 'string' ? body.email : '';
    const role = (body?.role as UserRole) ?? 'receptionist';
    return createInvitation(session, { email, role });
  });
}
