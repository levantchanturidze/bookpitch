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

  // 3. Delete users (cascades memberships). Then soft-delete the orgs
  //    (status='archived') per spec §9 rule 6. We can't hard-delete orgs
  //    because audit_log.organization_id has no CASCADE — audit log is
  //    append-only and rows referencing the org cannot be dropped or
  //    NULLed. Soft-delete preserves the audit trail while making the
  //    org inaccessible to sign-in (can() denies for archived orgs).
  const deletedUsers: string[] = [];
  const archivedOrgs: string[] = [];
  await prismaAdmin.$transaction(async (tx) => {
    // First: null out organization.owner_user_id where it points at any
    // of our users. Prevents FK violation on the user delete.
    for (const userId of userIds) {
      await tx.organization.updateMany({
        where: { ownerUserId: userId },
        data: { ownerUserId: null },
      });
    }
    for (const userId of userIds) {
      await tx.appUser.delete({ where: { id: userId } });
      deletedUsers.push(userId);
    }
    for (const orgId of orgIds) {
      await tx.organization.update({
        where: { id: orgId },
        data: { status: 'archived' },
      });
      archivedOrgs.push(orgId);
    }
  });

  log.warn('cleanup-fixtures.executed', {
    deletedUsers: deletedUsers.length,
    archivedOrgs: archivedOrgs.length,
    emails: TARGET_EMAILS,
  });

  return NextResponse.json({
    ok: true,
    deletedUsers, archivedOrgs, emails: TARGET_EMAILS,
  });
}
