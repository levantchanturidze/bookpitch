#!/usr/bin/env node
// Prints the migration rollback inventory in docs/migration-rollback-inventory.md
// (the table only), so the document can be regenerated rather than retyped.
//
//   node scripts/migration-rollback-inventory.mjs
//
// Everything it reports is LEXICAL: which statement kinds appear in each
// migration once comments are removed, and whether a rollback is written down.
// It does not decide that a rollback is safe. That needs the migration read.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'prisma',
  'migrations',
);

/** Function and trigger bodies (`AS $tag$ … $tag$`): code that runs LATER. */
const BODY = /\bAS\s+(\$\w*\$)[\s\S]*?\1/gi;

/** SQL with `--` line comments and block comments removed. */
function executable(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

const KINDS = {
  // Changes rows that already existed: not undone by dropping new objects.
  data: /\b(UPDATE\s+"?\w+"?\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/gi,
  // Removes something that held data or a guarantee.
  destructive:
    /\bDROP\s+(TABLE|COLUMN)\b|\bALTER\s+TABLE\s+[\w".]+\s+DROP\s+(COLUMN\s+)?(?!CONSTRAINT|DEFAULT|NOT\s+NULL)\w/gi,
  // Roles are cluster globals: a database restore does not bring them back.
  roles: /\b(CREATE|ALTER|DROP)\s+ROLE\b/gi,
  // A PostgreSQL enum value cannot be removed with one statement.
  enumAdd: /\bALTER\s+TYPE\s+[\w".]+\s+ADD\s+VALUE\b/gi,
};

const rows = readdirSync(DIR)
  .filter((n) => /^\d{14}_/.test(n))
  .sort()
  .map((name, i) => {
    const sql = readFileSync(path.join(DIR, name, 'migration.sql'), 'utf8');
    const all = executable(sql);
    // What runs when the migration applies, versus code it installs.
    const code = all.replace(BODY, ' ');
    const bodies = (all.match(BODY) ?? []).join('\n');
    const count = (re) => (code.match(re) ?? []).length;
    return {
      n: i + 1,
      name,
      rollback: /\b(rollback|roll back|reverse|down[- ]migration)\b/i.test(sql),
      ledger: /_prisma_migrations/.test(sql) && /DELETE\s+FROM\s+_prisma_migrations/i.test(sql),
      data: count(KINDS.data),
      installsWriters: (bodies.match(KINDS.data) ?? []).length,
      destructive: count(KINDS.destructive),
      roles: count(KINDS.roles),
      enumAdd: count(KINDS.enumAdd),
    };
  });

const yes = (b) => (b ? 'yes' : '**no**');
const n0 = (v) => (v === 0 ? '·' : String(v));
console.log(
  '| # | Migration | Rollback written | Deletes its ledger row | Writes rows on apply | Destructive | Roles | Enum values | Installs code that writes rows |',
);
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.n} | \`${r.name}\` | ${yes(r.rollback)} | ${r.rollback ? yes(r.ledger) : '—'} | ${n0(r.data)} | ${n0(r.destructive)} | ${n0(r.roles)} | ${n0(r.enumAdd)} | ${n0(r.installsWriters)} |`,
  );
}
const tot = (k) => rows.filter((r) => r[k] > 0).length;
console.error(
  JSON.stringify({
    migrations: rows.length,
    rollbackWritten: rows.filter((r) => r.rollback).length,
    deletesLedgerRow: rows.filter((r) => r.ledger).length,
    withDataChanges: tot('data'),
    installingWriters: tot('installsWriters'),
    withDestructive: tot('destructive'),
    withRoles: tot('roles'),
    withEnumAdds: tot('enumAdd'),
  }),
);
