import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { deleteUnlessReferenced } = await import('./helpers/delete-unless-referenced');
const { resetAuditForOrgs } = await import('./helpers/audit-reset');

// -----------------------------------------------------------------------------
// A database error swallowed inside an interactive transaction does not stay
// swallowed. PostgreSQL has already aborted the transaction, every later
// statement fails, and the commit silently rolls back everything, including
// what ran BEFORE the error, while the callback returns as if it had worked.
// #114 found this in production code (a failed waitlist fan-out erased a
// cancellation behind a 200). In tests the same shape makes a teardown a
// silent no-op: fixtures leak, and the next run inherits them.
//
// Teardowns that may legitimately be refused (an append-only audit_log row
// holding a foreign key) use deleteUnlessReferenced, which confines the
// refusal to a SAVEPOINT and lets every other failure fail the suite.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const SELF = path.join(ROOT, 'tests', 'no-swallowed-db-errors.test.ts');

/** `tx.<model>.<op>(…)` followed by `.catch` with an empty or value-only handler. */
const SWALLOW_ON_TX =
  /\btx\s*\.\s*\w+\s*\.\s*\w+\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/g;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return testFiles(p);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [p] : [];
  });
}

describe('no test swallows a database error inside a transaction', () => {
  it('the shape appears nowhere under tests/', () => {
    const hits: string[] = [];
    // This file reproduces the shape on purpose, below.
    for (const f of testFiles(path.join(ROOT, 'tests')).filter((f) => f !== SELF)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(SWALLOW_ON_TX)) {
        const line = src.slice(0, m.index).split('\n').length;
        hits.push(`${path.relative(ROOT, f)}:${line}`);
      }
    }
    expect(hits, 'use deleteUnlessReferenced, or let the error fail the suite').toEqual([]);
  });

  it('COMPLEMENT: the scan finds the shape, on one line or across several', () => {
    const swallow = '.catch(() => ' + '{})';
    const oneLine = `await tx.appUser.delete({ where: { id: x } })${swallow};`;
    const multiLine = `await tx.impersonationSession\n  .deleteMany({ where: { actorUserId: u, at: new Date(f(1)) } })\n  ${swallow};`;
    const asValue = 'tx.customer.delete({ where: { id } }).catch(() => ' + 'null)';
    for (const s of [oneLine, multiLine, asValue]) {
      expect(s.match(new RegExp(SWALLOW_ON_TX.source))).not.toBeNull();
    }
  });

  it('COMPLEMENT: a handled catch, or one outside a transaction, is not flagged', () => {
    const handled =
      'await tx.appUser.deleteMany({ where: { id } }).catch((e) => { if (e.code !== "P2003") throw e; });';
    const noTx = 'await res.json().catch(() => ' + 'null);';
    for (const s of [handled, noTx]) {
      expect(s.match(new RegExp(SWALLOW_ON_TX.source))).toBeNull();
    }
  });
});

describe('deleteUnlessReferenced keeps the rest of the transaction', () => {
  const stamp = Date.now();
  let orgId: string;
  let referenced: string; // held by an audit_log row
  let free: string; // held by nothing

  const statusOf = async (id: string) =>
    (await unsafePrismaAdmin.appUser.findUnique({ where: { id }, select: { status: true } }))
      ?.status ?? 'gone';

  beforeAll(async () => {
    const fx = await withoutRls(async (tx) => {
      // Archived: an ownerless live organisation breaks the ownership invariant.
      const org = await tx.organization.create({
        data: { name: `swallow-fixture-${stamp}`, status: 'archived' },
        select: { id: true },
      });
      const user = async (tag: string) =>
        (
          await tx.appUser.create({
            data: {
              authProvider: 'credentials',
              authSubject: `swallow-${tag}-${stamp}@bp.test`,
              email: `swallow-${tag}-${stamp}@bp.test`,
            },
            select: { id: true },
          })
        ).id;
      return { org: org.id, referenced: await user('referenced'), free: await user('free') };
    });
    orgId = fx.org;
    referenced = fx.referenced;
    free = fx.free;
    // Append-only and FK-holding, exactly what a real audited action leaves.
    await unsafePrismaAdmin.auditLog.create({
      data: {
        organizationId: orgId,
        actorUserId: referenced,
        action: 'update',
        entity: 'app_user',
        entityId: referenced,
      },
    });
  });

  afterAll(async () => {
    await resetAuditForOrgs([orgId]);
    await withoutRls(async (tx) => {
      await tx.appUser.deleteMany({ where: { id: { in: [referenced, free] } } });
      await tx.organization.deleteMany({ where: { id: orgId } });
    });
  });

  it('THE DEFECT, reproduced: swallowing the refusal also undoes the mark made before it', async () => {
    await unsafePrismaAdmin.appUser.update({
      where: { id: referenced },
      data: { status: 'active' },
    });
    const outcome = await withoutRls(async (tx) => {
      await tx.appUser.updateMany({ where: { id: referenced }, data: { status: 'deleted' } });
      await tx.appUser.deleteMany({ where: { id: referenced } }).catch(() => undefined);
      return 'callback returned normally';
    }).catch(() => 'transaction rejected');
    // Whichever way it ends, the mark did not survive.
    expect([outcome, await statusOf(referenced)]).toEqual(
      outcome === 'callback returned normally'
        ? ['callback returned normally', 'active']
        : ['transaction rejected', 'active'],
    );
  });

  it('with deleteUnlessReferenced the refusal stays in its SAVEPOINT, and the mark commits', async () => {
    await unsafePrismaAdmin.appUser.update({
      where: { id: referenced },
      data: { status: 'active' },
    });
    const result = await withoutRls(async (tx) => {
      await tx.appUser.updateMany({ where: { id: referenced }, data: { status: 'deleted' } });
      return deleteUnlessReferenced(tx, () => tx.appUser.deleteMany({ where: { id: referenced } }));
    });
    expect(result).toBe('referenced');
    expect(await statusOf(referenced)).toBe('deleted');
  });

  it('an unreferenced row is simply deleted', async () => {
    const result = await withoutRls((tx) =>
      deleteUnlessReferenced(tx, () => tx.appUser.deleteMany({ where: { id: free } })),
    );
    expect(result).toBe('deleted');
    expect(await statusOf(free)).toBe('gone');
  });

  it('any other failure propagates, and fails the transaction', async () => {
    await expect(
      withoutRls((tx) =>
        deleteUnlessReferenced(tx, () =>
          tx.$executeRawUnsafe('SELECT * FROM no_such_table_for_cleanup_test'),
        ),
      ),
    ).rejects.toThrow();
  });
});
