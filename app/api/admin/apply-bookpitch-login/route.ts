// ONE-SHOT — mint a probe SUPER user for the SEC-007 E2E sign-in test,
// verify grants against prod, then delete self after use.
// MINT_TOKEN gated. Same shape as the earlier one-shot for the SEC-007
// migration apply; retained pattern for the follow-up verification round.
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { unsafePrismaAdmin } from '@/lib/db';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-mint-token');
  const expected = process.env.MINT_TOKEN;
  if (!expected || !token || token !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; email?: string };
  const action = body.action ?? '';
  try {
    if (action === 'mint-super') {
      const email = typeof body.email === 'string' && body.email
        ? body.email.toLowerCase() : 'sec007-e2e-final@bookpitch.internal';
      const password = randomBytes(24).toString('base64url');
      const passwordHash = await hash(password);
      const superRole = await unsafePrismaAdmin.role.findFirstOrThrow({
        where: { key: 'SUPER_ADMIN', organizationId: null }, select: { id: true },
      });
      const user = await unsafePrismaAdmin.appUser.upsert({
        where: { email },
        create: {
          authProvider: 'credentials', authSubject: email, email,
          fullName: 'SEC-007 E2E final probe',
          passwordHash, platformRoleId: superRole.id, status: 'active',
        },
        update: { passwordHash, platformRoleId: superRole.id, status: 'active',
                  sessionVersion: { increment: 1 } },
        select: { id: true, email: true },
      });
      return NextResponse.json({ userId: user.id, email: user.email, password });
    }
    if (action === 'delete-probe-user') {
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : null;
      if (!email || !email.endsWith('@bookpitch.internal')) {
        return NextResponse.json({ error: 'must end with @bookpitch.internal' }, { status: 400 });
      }
      const user = await unsafePrismaAdmin.appUser.findUnique({
        where: { email }, select: { id: true },
      });
      if (!user) return NextResponse.json({ deleted: false, reason: 'not found' });
      const auditCount = await unsafePrismaAdmin.auditLog.count({
        where: { actorUserId: user.id },
      });
      if (auditCount === 0) {
        await unsafePrismaAdmin.appUser.delete({ where: { id: user.id } });
        return NextResponse.json({ deleted: true, method: 'hard' });
      }
      await unsafePrismaAdmin.appUser.update({
        where: { id: user.id },
        data: {
          status: 'deleted', passwordHash: null, platformRoleId: null,
          email: `deleted-${user.id}@bookpitch.invalid`,
          sessionVersion: { increment: 1 },
        },
      });
      return NextResponse.json({ deleted: true, method: 'soft-mask' });
    }
    return NextResponse.json({ error: 'action must be mint-super | delete-probe-user' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 400) }, { status: 500 });
  }
}
