import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { prismaAdmin } from '@/lib/db';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// TEMPORARY one-shot: delete the two 2026-07-24 fixture accounts
// (owner@bookpitch.dev, reception@bookpitch.dev) and any org where
// either is the owner. FK cascades handle memberships, locations,
// branches, staff, services, etc. Bearer MINT_TOKEN. Removed in the
// next commit.
export async function POST(req: NextRequest) {
  const secret = process.env.MINT_TOKEN;
  if (!secret) return NextResponse.json({ error: 'MINT_TOKEN not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const TARGET_EMAILS = ['owner@bookpitch.dev', 'reception@bookpitch.dev'] as const;

  // 1. Find the users + the orgs they belong to.
  const users = await prismaAdmin.appUser.findMany({
    where: { email: { in: [...TARGET_EMAILS] } },
    include: {
      memberships: { select: { organizationId: true } },
    },
  });
  if (users.length === 0) {
    return NextResponse.json({ ok: true, note: 'no matching users' });
  }
  const userIds = users.map((u) => u.id);
  const orgIds = Array.from(new Set(users.flatMap((u) => u.memberships.map((m) => m.organizationId))));

  // 2. Also refuse to touch orgs that have ANY customer / appointment / staff
  //    rows we didn't seed. Belt-and-braces against nuking a real tenant.
  for (const orgId of orgIds) {
    const [custCount, apptCount] = await Promise.all([
      prismaAdmin.customer.count({ where: { organizationId: orgId } }),
      prismaAdmin.appointment.count({ where: { organizationId: orgId } }),
    ]);
    if (custCount > 0 || apptCount > 0) {
      return NextResponse.json({
        error: 'refusing: org has real data',
        orgId, customers: custCount, appointments: apptCount,
      }, { status: 409 });
    }
  }

  // 3. Delete orgs (cascades memberships + locations + branches + staff + services).
  //    Do this BEFORE user delete so app_users.owner_user_id FKs resolve cleanly.
  //    Wrap in one transaction so partial cascade doesn't leave orphans.
  const deletedOrgs: string[] = [];
  const deletedUsers: string[] = [];
  await prismaAdmin.$transaction(async (tx) => {
    for (const orgId of orgIds) {
      await tx.organization.delete({ where: { id: orgId } });
      deletedOrgs.push(orgId);
    }
    for (const userId of userIds) {
      await tx.appUser.delete({ where: { id: userId } });
      deletedUsers.push(userId);
    }
  });

  log.warn('cleanup-fixtures.executed', {
    deletedUsers: deletedUsers.length,
    deletedOrgs: deletedOrgs.length,
    emails: TARGET_EMAILS,
  });

  return NextResponse.json({
    ok: true,
    deletedUsers, deletedOrgs, emails: TARGET_EMAILS,
  });
}
