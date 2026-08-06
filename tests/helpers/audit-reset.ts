import { unsafePrismaAdmin, withoutRls } from '@/lib/db';

// -----------------------------------------------------------------------------
// Test helper: purge audit_log rows for a specific set of organizations.
//
// audit_log is append-only in production (spec §9.11, invariant enforced by
// `audit_log_no_update` / `audit_log_no_delete` triggers). Test teardown that
// wants to hard-delete its fixture users / orgs must first release the FK
// grip audit_log has on them — using the documented dev escape hatch:
// DISABLE the user triggers, delete, ENABLE.
//
// Every call is scoped by organizationId(s). Never wipe the whole table.
// Never call this from application code — only from test teardown.
// -----------------------------------------------------------------------------
export async function resetAuditForOrgs(orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  // ALTER TABLE ... DISABLE TRIGGER USER cannot run inside a subtransaction
  // in Postgres, so keep this outside withoutRls().
  await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" DISABLE TRIGGER USER');
  try {
    await withoutRls((tx) => tx.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } }));
  } finally {
    await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" ENABLE TRIGGER USER');
  }
}
