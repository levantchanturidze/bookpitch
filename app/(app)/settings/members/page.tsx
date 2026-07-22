import { requireRole } from '@/lib/auth';
import { listMembers } from '@/lib/admin';
import MembersPanel from '@/components/settings/MembersPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsMembersPage() {
  const session = await requireRole('owner');
  const members = await listMembers(session);
  return <MembersPanel members={members} currentUserId={session.userId} />;
}
