import type { Prisma } from '@prisma/client';

/**
 * A teardown delete that may legitimately be refused by a foreign key: an
 * append-only audit_log row holding the user or organisation, typically.
 *
 * Inside an interactive transaction a refused statement aborts the WHOLE
 * transaction. Swallowing the error lets the callback return normally, and the
 * commit then silently rolls back everything before it too: the shape fixed in
 * app/api/appointments/[id] on #114. A SAVEPOINT confines the refusal to this
 * one statement. Only a foreign-key refusal is tolerated; anything else
 * propagates, so a broken cleanup fails the suite instead of hiding.
 */
export async function deleteUnlessReferenced(
  tx: Prisma.TransactionClient,
  del: () => Promise<unknown>,
): Promise<'deleted' | 'referenced'> {
  await tx.$executeRawUnsafe('SAVEPOINT cleanup_delete');
  try {
    await del();
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT cleanup_delete');
    return 'deleted';
  } catch (err) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cleanup_delete');
    if (isForeignKeyRefusal(err)) return 'referenced';
    throw err;
  }
}

function isForeignKeyRefusal(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
  };
  return e?.code === 'P2003' || e?.meta?.driverAdapterError?.cause?.originalCode === '23503';
}
