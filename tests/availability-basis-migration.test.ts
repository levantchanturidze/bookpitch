import { describe, it, expect, vi, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');

// -----------------------------------------------------------------------------
// The time_basis contract, AFTER the Stage D cutover.
//
// .github/workflows/migrate.yml applies migrations on push to main while Vercel
// deploys from the same push IN PARALLEL, so the PREVIOUS release serves for a
// minute or two against the POST-migration database. Everything below exists
// because of that overlap, and each assertion maps to a way it could corrupt
// data silently:
//
// From Stage A until the Stage D backfill the default was 'utc_legacy', because
// a build that knew nothing about the column would otherwise have had its
// UTC-form writes labelled local at birth — and then protected from correction
// by the very marker meant to prevent double conversion. That was the right
// contract for those three releases and it is deliberately no longer asserted:
// Stage D converted every remaining legacy row and only then moved the default.
//
// What must NEVER regress, and is asserted below:
//
//   explicit writes     application code states the basis on every write. A
//                       default is something a later migration can change
//                       underneath a writer — which is the hazard this column
//                       was introduced to remove, so leaning on it would put
//                       the hazard back.
//   CHECK constraint    a third basis would make the boundary meaningless
//                       without anything failing.
//   NOT NULL            provenance can never be absent.
//
// The value-preservation and abort-path halves are proven against
// production-shaped fixtures on throwaway databases before deployment; they
// cannot be asserted here, because this suite runs after the migrations have
// already applied.
// -----------------------------------------------------------------------------

const TRACKED: string[] = [];

describe('staff_availability.time_basis — post-cutover contract', () => {
  afterAll(async () => {
    if (TRACKED.length) {
      await withoutRls(async (tx) => {
        await tx.staffAvailability.deleteMany({ where: { staffId: { in: TRACKED } } });
        await tx.staff.deleteMany({ where: { id: { in: TRACKED } } });
      });
    }
  });

  it("defaults to 'local' now that every row is local and every writer explicit", async () => {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ column_default: string | null }>>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'staff_availability' AND column_name = 'time_basis'`,
    );
    // This was 'utc_legacy' for three releases, and moving it early would have
    // mislabelled an in-flight write from a build that did not know the column
    // existed. Stage D moved it only after converting every legacy row, with
    // the table locked and the conversion verified.
    expect(row?.column_default ?? '').toContain('local');
  });

  it('holds no legacy rows — the backfill is complete', async () => {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM staff_availability WHERE time_basis <> 'local'`,
    );
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it('is NOT NULL, so provenance can never be absent', async () => {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'staff_availability' AND column_name = 'time_basis'`,
    );
    expect(row?.is_nullable).toBe('NO');
  });

  it('never leaves the basis to the default — setAvailability states it', async () => {
    // THE DURABLE PROPERTY, and the one the whole rollout turns on. Stage B
    // wrote explicit 'utc_legacy'; Stage C writes explicit 'local'. Neither
    // read provenance from the column default, which is why moving that
    // default in Stage D could not change the meaning of a single row.
    //
    // Asserted by reading the source rather than the data, because a row
    // written today would look identical whether the basis came from the
    // writer or from the default — and it is the writer that must state it.
    const src = readFileSync(join(process.cwd(), 'lib/admin.ts'), 'utf8');
    const start = src.indexOf('staffAvailability.createMany');
    expect(start, 'setAvailability still writes through createMany').toBeGreaterThan(-1);
    // Bounded to the createMany call so this cannot be satisfied by the word
    // appearing anywhere else in the file.
    const call = src.slice(start, src.indexOf('});', start));
    expect(call).toMatch(/timeBasis:\s*'local'/);
  });

  it('refuses a basis the rollout does not define, even after the cutover', async () => {
    const staff = await seedStaff('post-cutover-check');
    await withoutRls((tx) =>
      tx.staffAvailability.create({
        data: {
          staffId: staff,
          weekday: 1,
          startTime: new Date('1970-01-01T09:00:00Z'),
          endTime: new Date('1970-01-01T17:00:00Z'),
          timeBasis: 'local',
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
