import type { PrismaClient } from '@prisma/client';

// -----------------------------------------------------------------------------
// Notification pub/sub.
//
// Every write to `notifications` also issues `pg_notify('bookpitch_events',
// <payload>)` in the same transaction so the fanout to SSE subscribers is
// transactionally consistent with the insert. Multi-instance friendly — the
// database itself is the pub/sub broker (no Redis / no in-process channel).
// -----------------------------------------------------------------------------

export const CHANNEL = 'bookpitch_events';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type NotificationType = 'booking' | 'payment' | 'reminder' | 'system';

export type NotificationEvent = {
  id: string;
  orgId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  createdAt: string;
};

export type NotifyInput = {
  type: NotificationType;
  title: string;
  body?: string | null;
};

/**
 * Insert a notifications row for `orgId` and NOTIFY the SSE channel in the
 * same tx. Safe to call from either a `withOrg` (tenant-scoped) OR a
 * `withoutRls` (system) transaction — RLS is set up so both write paths
 * work. Returns the payload that was broadcast.
 */
export async function notifyEvent(
  tx: TxClient,
  orgId: string,
  input: NotifyInput,
): Promise<NotificationEvent> {
  const row = await tx.notification.create({
    data: {
      organizationId: orgId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
    },
  });
  const event: NotificationEvent = {
    id: row.id,
    orgId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  // pg_notify takes a text payload. JSON-encode; consumers parse it back.
  // Prisma escapes the tagged-template value so this is injection-safe.
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(event)})`;
  return event;
}
