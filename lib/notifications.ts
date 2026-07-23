import type { PrismaClient } from '@prisma/client';

// -----------------------------------------------------------------------------
// Notification writer.
//
// The header bell polls `GET /api/notifications` every 30s (see the
// useNotifications hook). No SSE, no LISTEN/NOTIFY, no realtime vendor —
// the spec picks polling for MVP because it's dependency-free and free-tier
// Postgres has tight connection limits. Upgrade to SSE later if it earns it.
// -----------------------------------------------------------------------------

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type NotificationType = 'booking' | 'payment' | 'reminder' | 'system' | 'waitlist';

export type NotifyInput = {
  type: NotificationType;
  title: string;
  body?: string | null;
};

/**
 * Insert a notifications row for `orgId`. Safe to call from either a
 * `withOrg` (tenant-scoped) OR a `withoutRls` (system) transaction — RLS
 * is set up so both write paths work.
 */
export async function notifyEvent(
  tx: TxClient,
  orgId: string,
  input: NotifyInput,
): Promise<{ id: string; createdAt: string }> {
  const row = await tx.notification.create({
    data: {
      organizationId: orgId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
    },
  });
  return { id: row.id, createdAt: row.createdAt.toISOString() };
}
