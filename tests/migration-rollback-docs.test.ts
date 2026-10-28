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
 *
 * And nothing else in the section may be SQL. A second transaction after the
 * first, or a statement before it, runs separately: if it fails, the ledger row
 * is already gone and the rollback is partial (Codex review on #124, again).
 */
/** A line that starts a statement, not prose: an SQL verb in capitals, then its object. */
const SQL_STATEMENT =
  /^((BEGIN|COMMIT|END|ROLLBACK|START TRANSACTION|SAVEPOINT|TRUNCATE)\b|(DROP|ALTER|CREATE|GRANT|REVOKE) [A-Z]|(DELETE FROM|INSERT INTO|UPDATE|SELECT)\s|DO [$']|SET [a-z_]+\s*(=|TO\b))/;

/**
 * A step that changes the schema or the data, which a reverse step has to do.
 * Any other statement used to count, so `SELECT 1;` beside the ledger delete
 * passed (Codex review on #124), and that rollback deletes the ledger row and
 * leaves every object in place. A DO block counts when its body changes state.
 * Whether a step reverses THIS migration is still for review, and for the
 * executable rollback proof on a disposable copy (see #112's doc).
 */
const CHANGES_STATE =
  /^(DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|COMMENT ON|DELETE FROM|INSERT INTO|UPDATE)\b/i;
const reverses = (st: string) =>
  CHANGES_STATE.test(st) ||
  (/^DO\b/i.test(st) &&
    /\b(DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|DELETE|INSERT|UPDATE)\b/i.test(st));

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
  if (!statements.some((st) => !/_prisma_migrations/i.test(st) && reverses(st))) {
    problems.push('the rollback transaction reverses nothing but the ledger');
  }
  // Line by line: split on `;` instead and a statement after a line of prose
  // merges into the prose and is missed.
  const headingEnd = text.indexOf('\n') + 1;
  const commitEnd = begin.index + begin[0].length + commit.index + commit[0].length;
  const stray = [text.slice(headingEnd, begin.index), text.slice(commitEnd)]
    .flatMap((part) => part.split('\n'))
    .map((line) => line.trim())
    .find((line) => SQL_STATEMENT.test(line));
  if (stray) {
    problems.push(`the ROLLBACK section has SQL outside its one transaction: "${stray}"`);
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
      `the ROLLBACK section has SQL outside its one transaction: "DELETE FROM _prisma_migrations WHERE migration_name = '${name}';"`,
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

  it('COMPLEMENT (Codex on #124): a second transaction after the first is reported', () => {
    // The ledger row is deleted in the first; if the second then fails, the
    // rollback is partial and the ledger already says "not applied".
    const sql = complete.replace(
      '--   COMMIT;',
      '--   COMMIT;\n--   BEGIN;\n--   DROP INDEX IF EXISTS example_idx;\n--   COMMIT;',
    );
    expect(rollbackProblems(name, sql)).toEqual([
      'the ROLLBACK section has SQL outside its one transaction: "BEGIN;"',
    ]);
  });

  it('COMPLEMENT: a reverse step before the transaction is reported', () => {
    const sql = complete.replace(
      '--   BEGIN;',
      '--   DROP INDEX IF EXISTS example_idx;\n--   BEGIN;',
    );
    expect(rollbackProblems(name, sql)).toEqual([
      'the ROLLBACK section has SQL outside its one transaction: "DROP INDEX IF EXISTS example_idx;"',
    ]);
  });

  it('COMPLEMENT: a statement after a line of prose is still seen', () => {
    const sql = complete.replace(
      '-- Prose after the transaction is fine.',
      '-- Prose after the transaction is fine.\n--   DROP INDEX IF EXISTS example_idx;',
    );
    expect(rollbackProblems(name, sql)).toEqual([
      'the ROLLBACK section has SQL outside its one transaction: "DROP INDEX IF EXISTS example_idx;"',
    ]);
  });

  it('COMPLEMENT: prose around the transaction, even with semicolons and capitals, passes', () => {
    const sql = complete.replace(
      '-- Prose after the transaction is fine.',
      [
        '-- The ledger row goes in the SAME transaction; that is not optional.',
        '-- DO NOT split it, and do not run any of this by hand; use psql -f.',
        '-- Rolling back re-opens the old behaviour; nothing else depends on it.',
      ].join('\n'),
    );
    expect(rollbackProblems(name, sql)).toEqual([]);
  });

  it('COMPLEMENT (Codex on #124): a step that changes nothing does not count as a reverse', () => {
    for (const noop of [
      'SELECT 1;',
      "SET lock_timeout = '5s';",
      'DO $$ BEGIN PERFORM 1; END $$;',
    ]) {
      const sql = complete.replace('--   DROP TABLE IF EXISTS example;', `--   ${noop}`);
      expect(rollbackProblems(name, sql), noop).toEqual([
        'the rollback transaction reverses nothing but the ledger',
      ]);
    }
  });

  it('COMPLEMENT: a DO block whose body changes state is a reverse step', () => {
    const sql = complete.replace(
      '--   DROP TABLE IF EXISTS example;',
      "--   DO $$ BEGIN EXECUTE 'DROP TABLE IF EXISTS example'; END $$;",
    );
    expect(rollbackProblems(name, sql)).toEqual([]);
  });

  it('COMPLEMENT: a migration that EXECUTES a ledger change is refused', () => {
    const sql = `${complete}\nDELETE FROM _prisma_migrations WHERE migration_name = '${name}';`;
    expect(rollbackProblems(name, sql)).toContain(
      'the migration itself touches _prisma_migrations',
    );
  });
});
