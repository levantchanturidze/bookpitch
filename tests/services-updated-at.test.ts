import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { createLocation, createService, updateService } = await import('@/lib/admin');

// ---------------------------------------------------------------------------
// U-04 regression — found 2026-09-26 by the first test ever to call
// updateService().
//
// `services` carried BEFORE UPDATE trigger trg_services_updated running
// set_updated_at(), which assigns NEW.updated_at — but the column did not
// exist. Every UPDATE on services failed with SQLSTATE 42703,
// `record "new" has no field "updated_at"`, in every environment including
// production. Create and delete worked, so nothing looked wrong until someone
// renamed or repriced a service.
//
// Two assertions, because the column existing is not the same as the trigger
// working: the update must SUCCEED, and updated_at must ADVANCE.
// ---------------------------------------------------------------------------
describe('U-04 services.updated_at', () => {
  let orgId: string;
  let session: { organizationId: string; userId: string; email: string; membershipId: string };
  let userId: string;

  beforeAll(async () => {
    const ts = Date.now();
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `SvcUpdated Org ${ts}` } });
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `svc-${ts}@bookpitch.dev`,
          email: `svc-${ts}@bookpitch.dev`,
        },
      });
      const r = await tx.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null },
        select: { id: true },
      });
      const m = await tx.membership.create({
        data: { organizationId: org.id, userId: u.id, role: 'owner', roleId: r.id },
      });
      return { orgId: org.id, userId: u.id, mId: m.id, email: `svc-${ts}@bookpitch.dev` };
    });
    orgId = seed.orgId;
    userId = seed.userId;
    session = {
      organizationId: orgId,
      userId: seed.userId,
      email: seed.email,
      membershipId: seed.mId,
    };
  });

  afterAll(async () => {
    await withoutRls((tx) => tx.service.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.location.deleteMany({ where: { organizationId: orgId } }));
    // Invariant 5 is bidirectional: an org may not keep owner_user_id without an
    // active owner membership, NOR have members with owner_user_id cleared. Both
    // sides must therefore move inside ONE transaction, where the deferred check
    // sees the consistent end state rather than either half-step.
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.organization.updateMany({ where: { id: orgId }, data: { ownerUserId: null } });
    });
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([orgId]);
    await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: userId } }));
    await withoutRls((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  });

  it('updating a service succeeds and the trigger advances updated_at', async () => {
    const location = await createLocation(session, {
      type: 'clinic',
      name: 'U04 Location',
      timezone: 'Asia/Tbilisi',
    });
    const created = await createService(session, {
      locationId: location.id,
      name: 'U04 Service',
      price: 50,
      durationMinutes: 30,
    });
    const before = await withoutRls((tx) =>
      tx.service.findUniqueOrThrow({
        where: { id: created.id },
        select: { updatedAt: true },
      }),
    );

    // Before the fix this threw PrismaClientKnownRequestError P2022.
    const updated = await updateService(session, created.id, {
      locationId: location.id,
      name: 'U04 Service Renamed',
      price: 65,
      durationMinutes: 30,
    });
    expect(updated.name).toBe('U04 Service Renamed');
    expect(Number(updated.price)).toBe(65);

    const after = await withoutRls((tx) =>
      tx.service.findUniqueOrThrow({
        where: { id: created.id },
        select: { updatedAt: true },
      }),
    );
    // The trigger fired, rather than the column merely sitting at its default.
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it('every table wired to set_updated_at() actually has the column', async () => {
    // The generic form of U-04: the trigger and the column must never disagree
    // again, on any table.
    const rows = await withoutRls(
      (tx) =>
        tx.$queryRawUnsafe(`
        SELECT c.relname::text AS table_name
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc  p ON p.oid = t.tgfoid
         WHERE NOT t.tgisinternal
           AND p.proname = 'set_updated_at'
           AND NOT EXISTS (
             SELECT 1 FROM information_schema.columns col
              WHERE col.table_name = c.relname AND col.column_name = 'updated_at'
           )
      `) as Promise<Array<{ table_name: string }>>,
    );
    expect(
      rows.map((r) => r.table_name),
      'tables whose set_updated_at() trigger would fail with 42703',
    ).toEqual([]);
  });
});
