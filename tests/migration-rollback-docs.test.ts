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

/**
 * What is wrong with a migration's written rollback; empty when nothing is.
 *
 * The ROLLBACK section is the heading comment line and the contiguous comment
 * block under it. Inside it there must be ONE transaction, `BEGIN; … COMMIT;`,
 * and inside THAT the migration's own ledger delete and at least one statement
 * that reverses something. Matching the delete anywhere in the comments (the
 * first version) let `-- ROLLBACK: unavailable` plus an unrelated comment
 * quoting the delete pass (Codex review on #124).
 */
function rollbackProblems(name: string, sql: string): string[] {
  const lines = sql.split(/\r?\n/);
  const code = lines.map((l) => l.replace(/--.*$/, '')).join('\n');
  const problems: string[] = [];
  if (/_prisma_migrations/i.test(code)) {
    problems.push('the migration itself touches _prisma_migrations');
  }

  const at = lines.findIndex((l) => /^\s*--\s*ROLLBACK\b/i.test(l));
  if (at < 0) return [...problems, 'no ROLLBACK section in the header'];
  const section: string[] = [];
  for (let i = at; i < lines.length && /^\s*--/.test(lines[i]); i++) {
    section.push(lines[i].replace(/^\s*--/, ''));
  }
  const text = section.join('\n');
  const begin = /^\s*BEGIN\s*;/im.exec(text);
  const commit = begin ? /^\s*COMMIT\s*;/im.exec(text.slice(begin.index + begin[0].length)) : null;
  if (!begin || !commit) {
    return [...problems, 'the ROLLBACK section has no BEGIN; … COMMIT; transaction'];
  }
  const body = text.slice(begin.index + begin[0].length).slice(0, commit.index);
  const statements = body
    .split(';')
    .map((st) => st.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const ownRow = new RegExp(
    `^DELETE FROM _prisma_migrations WHERE migration_name ?= ?'${name}'$`,
    'i',
  );
  if (!statements.some((st) => ownRow.test(st))) {
    problems.push('the rollback transaction does not delete its own ledger row');
  }
  if (!statements.some((st) => !/_prisma_migrations/i.test(st))) {
    problems.push('the rollback transaction reverses nothing but the ledger');
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
    '--',
    '--   BEGIN;',
    '--   DROP TABLE IF EXISTS example;',
    '--   DELETE FROM _prisma_migrations',
    `--    WHERE migration_name = '${name}';`,
    '--   COMMIT;',
    '--',
    '-- Prose after the transaction is fine.',
    'CREATE TABLE example (id int);',
  ].join('\n');

  it('COMPLEMENT: a complete rollback passes, the ledger step split across lines', () => {
    expect(rollbackProblems(name, complete)).toEqual([]);
  });

  it('COMPLEMENT: a migration with no rollback written is reported', () => {
    expect(rollbackProblems(name, 'CREATE TABLE example (id int);')).toEqual([
      'no ROLLBACK section in the header',
    ]);
  });

  it('COMPLEMENT (Codex on #124): "ROLLBACK: unavailable" plus a quoted delete elsewhere fails', () => {
    const sql = [
      '-- ROLLBACK: unavailable.',
      'CREATE TABLE example (id int);',
      `-- Never run: DELETE FROM _prisma_migrations WHERE migration_name = '${name}';`,
    ].join('\n');
    expect(rollbackProblems(name, sql)).toEqual([
      'the ROLLBACK section has no BEGIN; … COMMIT; transaction',
    ]);
  });

  it('COMPLEMENT: a ledger delete AFTER the commit is not inside the transaction', () => {
    const sql = complete
      .replace(/--   DELETE FROM[\s\S]*?';\n/, '')
      .replace(
        '--   COMMIT;',
        `--   COMMIT;\n--   DELETE FROM _prisma_migrations WHERE migration_name = '${name}';`,
      );
    expect(rollbackProblems(name, sql)).toEqual([
      'the rollback transaction does not delete its own ledger row',
    ]);
  });

  it("COMPLEMENT: deleting ANOTHER migration's ledger row does not count", () => {
    const sql = complete.replace(`'${name}'`, "'20991231000001_other'");
    expect(rollbackProblems(name, sql)).toEqual([
      'the rollback transaction does not delete its own ledger row',
    ]);
  });

  it('COMPLEMENT: a transaction that only deletes the ledger row reverses nothing', () => {
    const sql = complete.replace('--   DROP TABLE IF EXISTS example;\n', '');
    expect(rollbackProblems(name, sql)).toEqual([
      'the rollback transaction reverses nothing but the ledger',
    ]);
  });

  it('COMPLEMENT: a migration that EXECUTES a ledger change is refused', () => {
    const sql = `${complete}\nDELETE FROM _prisma_migrations WHERE migration_name = '${name}';`;
    expect(rollbackProblems(name, sql)).toContain(
      'the migration itself touches _prisma_migrations',
    );
  });
});
