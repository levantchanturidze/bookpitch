import { requireSession, withApi } from '@/lib/auth';
import { withOrg } from '@/lib/db';

export async function POST() {
  return withApi(async () => {
    const session = await requireSession();
    const result = await withOrg(session.organizationId, (tx) => tx.notification.deleteMany({}));
    return { deleted: result.count };
  });
}
