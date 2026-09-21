import { describe, it, expect, vi, afterAll } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');

// -----------------------------------------------------------------------------
// STAGE A contract — the properties that make the migration/deploy overlap safe.
//
// .github/workflows/migrate.yml applies migrations on push to main while Vercel
// deploys from the same push IN PARALLEL, so the PREVIOUS release serves for a
// minute or two against the POST-migration database. Everything below exists
// because of that overlap, and each assertion maps to a way it could corrupt
// data silently:
//
//   default is 'utc_legacy'   an old build writes availability without knowing
//                             the column exists. If the default said 'local',
//                             its UTC-form value would be labelled local at
//                             birth and then protected from correction by the
//                             very marker meant to prevent double conversion.
//
//   CHECK constraint          a third basis would make the boundary meaningless
//                             without anything failing.
//
// The value-preservation half is proven against a production-shaped fixture on
// a throwaway database before deployment; it cannot be asserted here because
// this suite runs after the migration has already been applied.
// -----------------------------------------------------------------------------

const TRACKED: string[] = [];

describe('staff_availability.time_basis — Stage A migration contract', () => {
  afterAll(async () => {
    if (TRACKED.length) {
      await withoutRls(async (tx) => {
        await tx.staffAvailability.deleteMany({ where: { staffId: { in: TRACKED } } });
        await tx.staff.deleteMany({ where: { id: { in: TRACKED } } });
      });
    }
  });

  it("defaults to 'utc_legacy', so an old build's write is labelled correctly", async () => {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ column_default: string | null }>>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'staff_availability' AND column_name = 'time_basis'`,
    );
    // The single most important line in the rollout. Flipping this to 'local'
    // before Stage D is what mislabels an in-flight write from the old build.
    expect(row?.column_default ?? '').toContain('utc_legacy');
  });

  it('is NOT NULL, so provenance can never be absent', async () => {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'staff_availability' AND column_name = 'time_basis'`,
    );
    expect(row?.is_nullable).toBe('NO');
  });

  it('refuses a basis the rollout does not define', async () => {
    const staff = await seedStaff('basis-check');
    await withoutRls((tx) =>
      tx.staffAvailability.create({
        data: {
          staffId: staff,
          weekday: 1,
          startTime: new Date('1970-01-01T05:00:00Z'),
          endTime: new Date('1970-01-01T13:00:00Z'),
        },
      }),
    );
    await expect(
      withoutRls((tx) =>
        tx.$executeRawUnsafe(
          `UPDATE staff_availability SET time_basis = 'utc_guess' WHERE staff_id = $1::uuid`,
          staff,
        ),
      ),
    ).rejects.toThrow();
  });

  it('labels a row written WITHOUT the column as legacy — the old-build path', async () => {
    // Exactly what the pre-marker build does: it does not know the column
    // exists, so it never supplies it.
    const staff = await seedStaff('old-build-insert');
    await withoutRls((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time)
         VALUES ($1::uuid, 2, TIME '05:00', TIME '13:00')`,
        staff,
      ),
    );
    const rows = await withoutRls((tx) =>
      tx.staffAvailability.findMany({ where: { staffId: staff }, select: { timeBasis: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].timeBasis).toBe('utc_legacy');
  });

  it('leaves an existing row legacy when an old build UPDATEs it in place', async () => {
    // The third old-build write shape, and the one insert/delete-recreate
    // coverage misses. A pre-marker build issues UPDATE ... SET start_time =
    // without naming time_basis at all; the column keeps whatever it had, which
    // for a pre-existing row is 'utc_legacy'. If an UPDATE could silently
    // promote a row to 'local' while its bytes stayed UTC, every reader would
    // stop applying the offset and the window would move by four hours with
    // nothing failing.
    const staff = await seedStaff('old-build-update');
    await withoutRls((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time)
         VALUES ($1::uuid, 5, TIME '05:00', TIME '13:00')`,
        staff,
      ),
    );
    await withoutRls((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE staff_availability SET start_time = TIME '06:00', end_time = TIME '14:00'
          WHERE staff_id = $1::uuid`,
        staff,
      ),
    );
    const rows = await withoutRls((tx) =>
      tx.staffAvailability.findMany({
        where: { staffId: staff },
        select: { timeBasis: true, startTime: true },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].timeBasis).toBe('utc_legacy');
    // The value really did change; the basis really did not.
    expect(rows[0].startTime.getUTCHours()).toBe(6);
  });

  it('labels a DELETE-then-INSERT rewrite as legacy too', async () => {
    // setAvailability() replaces the whole schedule rather than updating rows,
    // so this is the shape an old build's save actually takes. A default of
    // 'local' would mislabel every window of it.
    const staff = await seedStaff('old-build-replace');
    await withoutRls((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time)
         VALUES ($1::uuid, 3, TIME '05:00', TIME '13:00')`,
        staff,
      ),
    );
    await withoutRls(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM staff_availability WHERE staff_id = $1::uuid`, staff);
      await tx.$executeRawUnsafe(
        `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time)
         VALUES ($1::uuid, 4, TIME '06:00', TIME '14:00')`,
        staff,
      );
    });
    const rows = await withoutRls((tx) =>
      tx.staffAvailability.findMany({ where: { staffId: staff }, select: { timeBasis: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].timeBasis).toBe('utc_legacy');
  });
});

async function seedStaff(label: string): Promise<string> {
  const loc = await withoutRls((tx) =>
    tx.location.findFirstOrThrow({ select: { id: true, organizationId: true } }),
  );
  const staff = await withoutRls((tx) =>
    tx.staff.create({
      data: {
        organizationId: loc.organizationId,
        locationId: loc.id,
        name: `basis ${label}`,
        roleTitle: 'Provider',
      },
      select: { id: true },
    }),
  );
  TRACKED.push(staff.id);
  return staff.id;
}
