import { redirect } from 'next/navigation';
import { requireAuthContext } from '@/lib/rbac';
import { unsafePrismaAdmin } from '@/lib/db';
import BreakGlassForm from '@/components/platform/BreakGlassForm';

export const metadata = { title: 'Break-glass · Platform' };
export const dynamic = 'force-dynamic';

/**
 * SUPER_ADMIN-only. Activation form: password + reason + ticketId +
 * optional target org. On successful POST, the caller's sessionVersion
 * is bumped; the next request sees ctx.breakGlass populated and the
 * (platform) shell renders the persistent red banner.
 */
export default async function BreakGlassPage() {
  const ctx = await requireAuthContext();
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { platformRole: { select: { key: true } } },
  });
  if (user.platformRole?.key !== 'SUPER_ADMIN') redirect('/platform/orgs');
  return <BreakGlassForm activeSession={ctx.breakGlass} />;
}
