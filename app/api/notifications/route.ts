import { requireSession, withApi } from '@/lib/auth';
import { withOrg } from '@/lib/db';

// GET /api/notifications — last 30 for the caller's org.
export async function GET() {
  return withApi(async () => {
    const session = await requireSession();
    const items = await withOrg(session.organizationId, (tx) =>
      tx.notification.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    );
    return {
      notifications: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  });
}
