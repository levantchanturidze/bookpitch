import { describe, it, expect } from 'vitest';
import { prismaApp, unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// Every tenant-isolation policy in this database is one expression:
//
//     organization_id = current_org_id()
//
// The production invariant script checks that each policy says exactly that,
// on the right table, for the right command, with FORCE on. It never checked
// what `current_org_id()` IS.
//
// That is the whole of the isolation, resting on a function nothing verified.
// The interesting part is that every way of breaking it leaves the policies
// looking perfect:
//
//   * `LANGUAGE sql AS $$ SELECT '…'::uuid $$` — a constant. Every policy still
//     reads `= current_org_id()`, and every tenant sees one particular org's
//     rows.
//   * `SECURITY DEFINER` with a body that reads something else — same text,
//     different authority.
//   * `VOLATILE` instead of `STABLE` — the planner may re-evaluate it per row;
//     correctness now depends on nothing changing mid-statement.
//   * `RETURNS text` — the comparison silently becomes text-vs-uuid, and a
//     malformed setting throws instead of denying, or casts loosely.
//   * a second definition in a schema earlier on `search_path` — the policies
//     resolve to the shadow, and `public.current_org_id` looks untouched.
//   * an overload taking an argument, so a later migration binds the wrong one.
//
// None of that is hypothetical enough to skip: `CREATE OR REPLACE FUNCTION` is
// one statement, and it does not need to touch a single policy.
//
// These tests pin the function itself. The drift cases below are proven by
// building deliberately-wrong probe functions and showing the SAME predicate
// rejects each one — otherwise this file would be six assertions that happen to
// be true today, with no evidence they could ever be false.
// -----------------------------------------------------------------------------

/** The body, whitespace-normalised. Any change to the logic changes this. */
const EXPECTED_BODY = "SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;";

type Properties = {
  schema: string;
  nargs: number;
  rettype: string;
  lang: string;
  volatility: string;
  security_definer: boolean;
  proconfig: string | null;
  owner: string;
  body: string;
};

/** Read every property that decides what this function does. */
async function properties(name: string): Promise<Properties[]> {
  return unsafePrismaAdmin.$queryRawUnsafe<Properties[]>(
    `SELECT n.nspname                    AS schema,
            p.pronargs::int              AS nargs,
            t.typname                    AS rettype,
            l.lanname                    AS lang,
            -- provolatile is "char"; the driver cannot map that type, so it
            -- has to be cast before it leaves Postgres.
            p.provolatile::text          AS volatility,
            p.prosecdef                  AS security_definer,
            p.proconfig::text            AS proconfig,
            pg_get_userbyid(p.proowner)  AS owner,
            regexp_replace(btrim(p.prosrc), '\\s+', ' ', 'g') AS body
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_type t ON t.oid = p.prorettype
       JOIN pg_language l ON l.oid = p.prolang
      WHERE p.proname = $1
      ORDER BY n.nspname`,
    name,
  );
}

/** The judgement, applied to whatever `properties()` returned. */
function violations(rows: Properties[]): string[] {
  const bad: string[] = [];
  if (rows.length !== 1) {
    // More than one is already fatal: which one a policy binds to depends on
    // search_path, which is per-session and not something a policy records.
    bad.push(`expected exactly one definition, found ${rows.length}`);
    if (rows.length === 0) return bad;
  }
  const f = rows[0];
  if (f.schema !== 'public') bad.push(`schema is ${f.schema}`);
  if (f.nargs !== 0) bad.push(`takes ${f.nargs} argument(s)`);
  if (f.rettype !== 'uuid') bad.push(`returns ${f.rettype}`);
  if (f.lang !== 'sql') bad.push(`language is ${f.lang}`);
  if (f.volatility !== 's') bad.push(`volatility is ${f.volatility}, expected STABLE`);
  if (f.security_definer) bad.push('is SECURITY DEFINER');
  if (f.proconfig !== null) bad.push(`carries a settings override: ${f.proconfig}`);
  if (f.body.trim() !== EXPECTED_BODY) bad.push(`body is: ${f.body.trim()}`);
  return bad;
}

describe('current_org_id() is exactly the function the policies assume', () => {
  it('has every property tenant isolation depends on', async () => {
    expect(violations(await properties('current_org_id'))).toEqual([]);
  });

  it('is not owned by the application role, which cannot replace it either', async () => {
    // Ownership and CREATE are the two ways to redefine it. `bookpitch_app` is
    // NOSUPERUSER NOBYPASSRLS, but neither of those stops a role from
    // CREATE OR REPLACE-ing a function it owns, or creating one in a schema it
    // can write to. Both have to be false or the isolation is advisory.
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{ owner: string; can_create: boolean }>
    >(
      `SELECT pg_get_userbyid(p.proowner) AS owner,
              has_schema_privilege('bookpitch_app', 'public', 'CREATE') AS can_create
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'current_org_id'`,
    );
    expect(row.owner, 'the app role must not own the function that gates it').not.toBe(
      'bookpitch_app',
    );
    expect(row.can_create, 'the app role must not be able to create in public').toBe(false);
  });
});

describe('the property check actually rejects a broken function', () => {
  // Building the wrong versions and running the SAME predicate over them.
  // CREATE FUNCTION takes no table lock, so this cannot contend with the shared
  // pool the way a DDL on a table would.
  const PROBE = 'bp_probe_org_id';
  const FAITHFUL = `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS uuid
      LANGUAGE sql STABLE AS $f$
      SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid; $f$`;

  async function withProbe(definition: string, run: () => Promise<void>) {
    await unsafePrismaAdmin.$executeRawUnsafe(definition);
    try {
      await run();
    } finally {
      await unsafePrismaAdmin.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS public.${PROBE}() CASCADE`,
      );
      await unsafePrismaAdmin.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS public.${PROBE}(uuid) CASCADE`,
      );
    }
  }

  const cases: Array<[string, string, RegExp]> = [
    [
      'a hard-coded organization id',
      `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS uuid LANGUAGE sql STABLE AS $f$
         SELECT '00000000-0000-0000-0000-000000000001'::uuid; $f$`,
      /body is:/,
    ],
    [
      'SECURITY DEFINER',
      `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS uuid LANGUAGE sql STABLE
         SECURITY DEFINER AS $f$
         SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid; $f$`,
      /SECURITY DEFINER/,
    ],
    [
      'VOLATILE instead of STABLE',
      `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS uuid LANGUAGE sql VOLATILE AS $f$
         SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid; $f$`,
      /volatility is v/,
    ],
    [
      'returning text rather than uuid',
      `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS text LANGUAGE sql STABLE AS $f$
         SELECT NULLIF(current_setting('app.current_org_id', true), ''); $f$`,
      /returns text/,
    ],
    [
      'a settings override baked into the function',
      `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS uuid LANGUAGE sql STABLE
         SET search_path = pg_catalog AS $f$
         SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid; $f$`,
      /settings override/,
    ],
    [
      'plpgsql with a different body',
      `CREATE OR REPLACE FUNCTION public.${PROBE}() RETURNS uuid LANGUAGE plpgsql STABLE AS $f$
         BEGIN RETURN current_setting('app.current_org_id', true)::uuid; END; $f$`,
      /language is plpgsql/,
    ],
  ];

  for (const [label, ddl, expected] of cases) {
    it(`rejects ${label}`, async () => {
      await withProbe(ddl, async () => {
        expect(violations(await properties(PROBE)).join(' | ')).toMatch(expected);
      });
    });
  }

  it('rejects a second, shadowing definition', async () => {
    // The nastiest one: `public.current_org_id` stays exactly right, and a copy
    // in a schema earlier on search_path answers instead.
    await withProbe(FAITHFUL, async () => {
      await unsafePrismaAdmin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS bp_probe_shadow`);
      try {
        await unsafePrismaAdmin.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION bp_probe_shadow.${PROBE}() RETURNS uuid
             LANGUAGE sql STABLE AS $f$ SELECT '00000000-0000-0000-0000-000000000002'::uuid; $f$`,
        );
        expect(violations(await properties(PROBE)).join(' | ')).toMatch(
          /expected exactly one definition, found 2/,
        );
      } finally {
        await unsafePrismaAdmin.$executeRawUnsafe(`DROP SCHEMA bp_probe_shadow CASCADE`);
      }
    });
  });

  it('rejects an overload that takes an argument', async () => {
    await withProbe(FAITHFUL, async () => {
      await unsafePrismaAdmin.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION public.${PROBE}(o uuid) RETURNS uuid
           LANGUAGE sql STABLE AS $f$ SELECT o; $f$`,
      );
      expect(violations(await properties(PROBE)).join(' | ')).toMatch(
        /expected exactly one definition, found 2/,
      );
    });
  });

  it('accepts a faithful copy — the predicate is not simply always failing', async () => {
    await withProbe(FAITHFUL, async () => {
      expect(violations(await properties(PROBE))).toEqual([]);
    });
  });
});

describe('current_org_id() fails closed', () => {
  it('is NULL with no organization context', async () => {
    const [row] = await prismaApp.$queryRawUnsafe<Array<{ v: string | null }>>(
      `SELECT current_org_id() AS v`,
    );
    expect(row.v).toBeNull();
  });

  it('is NULL when the setting is empty rather than absent', async () => {
    // `SET … = ''` is what a naive "clear the context" does. NULLIF turns it
    // back into NULL; without it, ''::uuid throws and every request 500s.
    const rows = await prismaApp.$queryRawUnsafe<Array<{ v: string | null }>>(
      `SELECT set_config('app.current_org_id', '', true) IS NOT NULL AS ignored,
              current_org_id() AS v`,
    );
    expect(rows[0].v).toBeNull();
  });

  it('a malformed organization context DENIES rather than matching anything', async () => {
    // The cast throws, the statement fails, no rows come back. Loud, and on the
    // safe side. What must never happen is a value that compares equal to
    // something.
    await expect(
      prismaApp.$queryRawUnsafe(
        `SELECT set_config('app.current_org_id', 'not-a-uuid', true), current_org_id()`,
      ),
    ).rejects.toThrow();
  });

  it('with NULL context, a tenant table returns nothing at all', async () => {
    // The property that matters, stated end to end rather than inferred from
    // the function: `organization_id = NULL` is NULL, never true, so the policy
    // filters every row.
    const rows = await prismaApp.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM customers`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
