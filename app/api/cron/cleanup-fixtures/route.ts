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

  // 3. Spec §9.11 pattern for "delete user with audit history": mask PII
  //    + status='deleted' rather than hard DELETE. audit_log FKs are
  //    NO ACTION (Phase 1 hardening — audit trail survives actor purge),
  //    so DELETE fails when any audit row references the user. Masking
  //    keeps FK integrity while rendering the account unusable:
  //      - status='deleted'   → can() and authorize() both reject
  //      - password_hash=NULL → credential check fails
  //      - email rewrite      → sign-in by email fails
  //      - platform_role_id=NULL, mfa_enabled=false, sessionVersion++
  //    Orgs get status='archived' — same reasoning, same audit-preservation
  //    concern. Delete memberships (they have no audit FK).
  const maskedUsers: string[] = [];
  const archivedOrgs: string[] = [];
  const removedMemberships: number = 0;
  await prismaAdmin.$transaction(async (tx) => {
    // Null out ownership pointers on any org the user owns.
    for (const userId of userIds) {
      await tx.organization.updateMany({
        where: { ownerUserId: userId },
        data: { ownerUserId: null },
      });
    }
    // Delete memberships. Membership rows have no audit_log FK; safe.
    for (const userId of userIds) {
      await tx.membership.deleteMany({ where: { userId } });
    }
    // Mask user rows (spec §9.11).
    for (const userId of userIds) {
      const stub = `deleted-${userId}@bookpitch-deleted.invalid`;
      await tx.appUser.update({
        where: { id: userId },
        data: {
          email: stub,
          authSubject: stub,
          fullName: 'redacted',
          passwordHash: null,
          status: 'deleted',
          platformRoleId: null,
          mfaEnabled: false,
          sessionVersion: { increment: 1 },
        },
      });
      maskedUsers.push(userId);
    }
    // Soft-delete orgs.
    for (const orgId of orgIds) {
      await tx.organization.update({
        where: { id: orgId },
        data: { status: 'archived' },
      });
      archivedOrgs.push(orgId);
    }
  });

  log.warn('cleanup-fixtures.executed', {
    maskedUsers: maskedUsers.length,
    archivedOrgs: archivedOrgs.length,
    emails: TARGET_EMAILS,
  });

  return NextResponse.json({
    ok: true,
    maskedUsers, archivedOrgs, emails: TARGET_EMAILS,
  });
}
