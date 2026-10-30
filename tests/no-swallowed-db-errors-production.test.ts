import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { scanForSwallows } from './helpers/tx-swallow-scan';

// -----------------------------------------------------------------------------
// tests/no-swallowed-db-errors.test.ts keeps TEST code from swallowing a
// database error inside a transaction. This keeps PRODUCTION code from it,
// which is where #114 found the shape: a failed waitlist fan-out inside PATCH
// /api/appointments/[id] rolled back the cancellation itself behind a 200.
//
// The scan is in tests/helpers/tx-swallow-scan.ts. The cases below pin it, so
// a broken scanner fails instead of passing everything.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

/**
 * Known instances, each with the reason it may stay until removed. Only
 * ever shrinks: an entry that no longer matches is fine (the instance was
 * fixed), a NEW instance is not.
 */
const KNOWN: Record<string, string> = {
  // removeSubscription: the delete is the transaction's only statement, so the
  // swallow aborts nothing else. #125 removes it (deleteMany, no catch).
  'lib/push.ts:catch-on-tx-call': 'harmless single-statement transaction; removed by #125',
  // The cancellation's waitlist fan-out in a bare catch: the very shape that
  // rolled back the cancellation behind a 200. #114 replaces it with a
  // SAVEPOINT (notifyWaitlistForCancelled in its own scope).
  'app/api/appointments/[id]/route.ts:try-catch-in-tx': 'the #114 defect itself; removed by #114',
  // nominateTransfer's nominee notification in a plain catch: a failed
  // statement silently rolled back the nomination itself (DEF-52). Found by
  // this scan; #131 scopes it to a SAVEPOINT.
  'lib/admin/ownership-transfer.ts:try-catch-in-tx': 'DEF-52; removed by #131',
};

function productionFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push({ path: path.relative(ROOT, p), text: readFileSync(p, 'utf8') });
      }
    }
  };
  for (const r of ['app', 'lib', 'components']) walk(path.join(ROOT, r));
  return out;
}

describe('no production code swallows a database error inside a transaction', () => {
  it('the shapes appear nowhere in app/, lib/ or components/', () => {
    const hits = scanForSwallows(productionFiles())
      .filter((s) => !KNOWN[`${s.file}:${s.shape}`])
      .map((s) => `${s.file}:${s.line} (${s.shape})`);
    expect(
      hits,
      'rethrow, tolerate the failure inside a SAVEPOINT, or catch outside the transaction',
    ).toEqual([]);
  });
});

describe('the scanner', () => {
  // Built by concatenation, as tests/no-swallowed-db-errors.test.ts does, so
  // its scan of tests/ does not take these synthetic sources for real ones.
  const c = '.cat' + 'ch(';
  const scan = (text: string) =>
    scanForSwallows([{ path: 'lib/sample.ts', text }]).map((s) => s.shape);

  it('finds a catch that does not rethrow, in both shapes', () => {
    expect(
      scan(`
        export async function a(id: string) {
          await withOrg(org, async (tx) => {
            await tx.customer.update({ where: { id }, data: {} });
            await tx.waitlist.delete({ where: { id } })${c}() => null);
          });
        }
        export async function b(id: string) {
          await withoutRls(async (tx) => {
            try {
              await tx.notification.create({ data: {} });
            } catch {
              log.warn('ignored');
            }
          });
        }
        export async function h(id: string) {
          await withOrg(org, async (tx) => {
            try {
              await notifyWaitlistForCancelled(tx, session, { id });
            } catch {
              /* swallow */
            }
          });
        }
        export async function c(tx: TxClient) {
          try {
            await tx.$executeRawUnsafe('SELECT 1');
          } catch (e) {
            console.error(e);
          }
        }
      `),
    ).toEqual(['catch-on-tx-call', 'try-catch-in-tx', 'try-catch-in-tx', 'try-catch-in-tx']);
  });

  it('COMPLEMENT: a rethrow, a never-returning mapper, a savepoint, or a catch outside the transaction is fine', () => {
    expect(
      scan(`
        function mapPrismaError(err: unknown): never { throw err; }
        export async function d(id: string) {
          await withOrg(org, async (tx) => {
            try { await tx.customer.delete({ where: { id } }); } catch (e) { mapPrismaError(e); }
            try { await tx.customer.delete({ where: { id } }); } catch (e) { if (x) throw e; throw e; }
            await tx.$executeRawUnsafe('SAVEPOINT s');
            try { await tx.waitlist.updateMany({ where: {}, data: {} }); }
            catch (e) { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s'); log.error('x'); }
            await tx.customer.findMany({})${c}(e) => { throw e; });
          });
          await withOrg(org, (tx) => tx.customer.findMany({}))${c}() => []);
          try { await fetch('x'); } catch { /* not a transaction */ }
        }
      `),
    ).toEqual([]);
  });
});
