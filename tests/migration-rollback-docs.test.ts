import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// -----------------------------------------------------------------------------
// Every migration from 2026-10-17 on carries a COMPLETE written rollback.
//
// 36 of the first 74 migrations document a rollback, and not one of them
// mentions `_prisma_migrations`. Dropping a migration's objects leaves its
// ledger row saying "applied": the next deploy reports "No pending
// migrations" and the objects stay gone, silently.
// `prisma migrate resolve --rolled-back` does not help: Prisma refuses it for a
// migration that SUCCEEDED (P3012, measured 2026-10-17). So a written rollback
// must delete the migration's own ledger row, in the same transaction.
//
// Applied migrations are not edited (their checksums are recorded), so the
// older ones are covered by docs/migration-rollback-inventory.md instead.
// -----------------------------------------------------------------------------

const DIR = path.resolve(__dirname, '..', 'prisma', 'migrations');
/** Migrations at or after this timestamp must satisfy the rule. */
const ROLLBACK_RULE_FROM = '20261017000000';

/** What is wrong with a migration's written rollback; empty when nothing is. */
function rollbackProblems(name: string, sql: string): string[] {
  const lines = sql.split(/\r?\n/);
  const comments = lines
    .filter((l) => /^\s*--/.test(l))
    .map((l) => l.replace(/^\s*--/, ''))
    .join('\n');
  const code = lines.map((l) => l.replace(/--.*$/, '')).join('\n');
  const problems: string[] = [];
  if (!/^\s*ROLLBACK\b/im.test(comments)) problems.push('no ROLLBACK section in the header');
  const ownRow = new RegExp(
    `DELETE\\s+FROM\\s+_prisma_migrations\\s+WHERE\\s+migration_name\\s*=\\s*'${name}'`,
    'i',
  );
  if (!ownRow.test(comments)) problems.push('the rollback does not delete its own ledger row');
  if (/_prisma_migrations/i.test(code)) {
    problems.push('the migration itself touches _prisma_migrations');
  }
  return problems;
}

const subject = readdirSync(DIR)
  .filter((n) => /^\d{14}_/.test(n) && n.slice(0, 14) >= ROLLBACK_RULE_FROM)
  .sort();

describe('new migrations document a rollback that a deploy will not silently undo', () => {
  it.each(subject.length ? subject : ['(none yet: the first is #112)'])('%s', (name) => {
    if (name.startsWith('(none yet')) return;
    const sql = readFileSync(path.join(DIR, name, 'migration.sql'), 'utf8');
    expect(rollbackProblems(name, sql)).toEqual([]);
  });

  const name = '20991231000000_example';
  const complete = [
    '-- ROLLBACK (the tested reverse):',
    '--   BEGIN;',
    '--   DROP TABLE IF EXISTS example;',
    '--   DELETE FROM _prisma_migrations',
    `--    WHERE migration_name = '${name}';`,
    '--   COMMIT;',
    'CREATE TABLE example (id int);',
  ].join('\n');

  it('COMPLEMENT: a complete rollback passes, the ledger step split across lines', () => {
    expect(rollbackProblems(name, complete)).toEqual([]);
  });

  it('COMPLEMENT: a migration with no rollback written is reported', () => {
    expect(rollbackProblems(name, 'CREATE TABLE example (id int);')).toContain(
      'no ROLLBACK section in the header',
    );
  });

  it('COMPLEMENT: a rollback that drops the objects but keeps the ledger row is reported', () => {
    const sql = complete.replace(/--   DELETE FROM[\s\S]*?';\n/, '');
    expect(rollbackProblems(name, sql)).toEqual([
      'the rollback does not delete its own ledger row',
    ]);
  });

  it("COMPLEMENT: deleting ANOTHER migration's ledger row does not count", () => {
    const sql = complete.replace(`'${name}'`, "'20991231000001_other'");
    expect(rollbackProblems(name, sql)).toEqual([
      'the rollback does not delete its own ledger row',
    ]);
  });

  it('COMPLEMENT: a migration that EXECUTES a ledger change is refused', () => {
    const sql = `${complete}\nDELETE FROM _prisma_migrations WHERE migration_name = '${name}';`;
    expect(rollbackProblems(name, sql)).toContain(
      'the migration itself touches _prisma_migrations',
    );
  });
});
