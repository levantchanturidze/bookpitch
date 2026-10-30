// -----------------------------------------------------------------------------
// DEF-08 — inventory every query that touches tenant data, and say what
// enforces its tenant boundary.
//
//   npx tsx scripts/tenant-query-inventory.ts            # markdown summary
//   npx tsx scripts/tenant-query-inventory.ts --json     # one object per query
//
// CLAUDE.md invariant 1 says every query touching tenant data filters by
// `organization_id`. Most queries in this codebase instead rely on RLS alone:
// they run inside withOrg(), which sets `app.current_org_id`, and the
// `tenant_isolation` policy on each table does the filtering. That holds only
// while RLS holds. This script makes the reliance countable, so a sweep can be
// planned and a regression can be caught (tests/tenant-query-inventory.test.ts).
//
// What it classifies, per call site:
//   context  — what enforces the boundary if the query names no organisation:
//                rls        inside withOrg()/withOrgReplica(): RLS filters
//                bypass     withoutRls(), unsafePrismaAdmin, prismaLogin, or a
//                           $transaction on one of them: NOTHING filters
//                caller-tx  a client handed in by the caller: whatever the
//                           caller opened (resolve through the call graph)
//                app-no-org prismaApp/prismaReplica outside withOrg: RLS with no
//                           org set, which returns no tenant rows (fail closed)
//   orgNamed — the query itself names the organisation: an `organizationId`
//              key (or `organization_id` in SQL), a compound unique key
//              containing it, a relation filter through a model that carries
//              it, or `id` on the organization model itself.
//   byId     — the query is keyed by one record's id: the shape an IDOR uses.
//
// It is a static, syntactic tool. It sees the query text, not the values: a
// query that names `organizationId: someValue` is "orgNamed" whatever
// `someValue` is, so bypass-context rows still need a human to confirm where the
// value comes from. docs/tenant-isolation-audit.md records that review.
// -----------------------------------------------------------------------------
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type Context = 'rls' | 'bypass' | 'caller-tx' | 'app-no-org' | 'unknown';

export type QuerySite = {
  file: string;
  line: number;
  fn: string;
  kind: 'prisma' | 'sql';
  target: string; // prisma model, or the tenant tables a SQL statement names
  op: string;
  receiver: string;
  context: Context;
  orgNamed: boolean;
  byId: boolean;
};

const ROOTS = ['app', 'lib', 'components'];

// Prisma client property → the tables it maps to. Every model whose rows belong
// to one organisation, directly (`organizationId`) or through a parent.
export const TENANT_MODELS: Record<string, string> = {
  organization: 'organizations',
  location: 'locations',
  membership: 'memberships',
  staff: 'staff',
  staffAvailability: 'staff_availability',
  service: 'services',
  customer: 'customers',
  treatmentHistory: 'treatment_history',
  appointment: 'appointments',
  payment: 'payments',
  messageTemplate: 'message_templates',
  messageLog: 'message_log',
  notification: 'notifications',
  assistantUsage: 'assistant_usage',
  waitlist: 'waitlist',
  invitation: 'invitations',
  rateLimit: 'rate_limit',
  auditLog: 'audit_log',
  branch: 'branches',
  membershipBranch: 'membership_branches',
  impersonationSession: 'impersonation_sessions',
  ownershipTransfer: 'ownership_transfers',
  breakGlassSession: 'break_glass_sessions',
};

const TENANT_TABLES = new Set(Object.values(TENANT_MODELS));

const OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

const BYPASS_CLIENTS = new Set(['unsafePrismaAdmin', 'prismaLogin']);
const APP_CLIENTS = new Set(['prismaApp', 'prismaReplica']);

// Keys that name the organisation. `targetOrganizationId` is break-glass's.
const ORG_KEY = /\b(organizationId|targetOrganizationId|organization_id)\b/;
// A compound unique selector containing the org, e.g. `organizationId_userId`.
// (A relation filter through a model that carries the org, such as
// `staff: { organizationId }`, already matches ORG_KEY.)
const ORG_COMPOUND = /\borganizationId_[A-Za-z_]+\b/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(p, out);
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(test|spec)\.tsx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(p);
    }
  }
}

function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      return n.name ? n.name.getText() : '(anonymous)';
    }
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      if (ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
      if (ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    }
  }
  return '(module)';
}

/** Is `name` a parameter of some function enclosing `node`? */
function isEnclosingParam(node: ts.Node, name: string): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return true;
      }
    }
  }
  return false;
}

/**
 * The nearest enclosing withOrg()/withoutRls()/$transaction() callback, and
 * the receiver's own name, decide the context.
 */
function contextOf(node: ts.Node, receiver: string): Context {
  if (BYPASS_CLIENTS.has(receiver)) return 'bypass';
  if (APP_CLIENTS.has(receiver)) return 'app-no-org';
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isCallExpression(n)) continue;
    const callee = n.expression.getText();
    // Only a callback ARGUMENT of the call counts, not the call's own receiver.
    const insideArg = n.arguments.some((a) => node.pos >= a.pos && node.end <= a.end);
    if (!insideArg) continue;
    if (/(^|\.)withOrg(Replica)?$/.test(callee)) {
      // The callback's parameter is the RLS-scoped client only if the query
      // uses THAT parameter; a query on a captured outer client is not scoped.
      const cb = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as
        ts.ArrowFunction | ts.FunctionExpression | undefined;
      const param = cb?.parameters[0]?.name.getText();
      if (param === receiver) return 'rls';
      continue;
    }
    if (/(^|\.)withoutRls$/.test(callee)) return 'bypass';
    if (/^(unsafePrismaAdmin|prismaLogin)\.\$transaction$/.test(callee)) return 'bypass';
    if (/^(prismaApp|prismaReplica)\.\$transaction$/.test(callee)) return 'app-no-org';
  }
  if (isEnclosingParam(node, receiver)) return 'caller-tx';
  return 'unknown';
}

/**
 * The part of a Prisma call that decides WHICH rows it touches: the `where`,
 * or a create's `data`. Never the `select`, `include` or an update's `data`:
 * selecting organizationId does not filter by it (Codex review on #128). An
 * argument that is not an object literal cannot be read here, and counts as
 * naming nothing.
 */
function prismaPredicateText(
  op: string,
  args: readonly ts.Expression[],
  sf: ts.SourceFile,
): string {
  const first = args[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return '';
  const keys = /^create(Many(AndReturn)?)?$/.test(op) ? ['data'] : ['where'];
  return first.properties
    .filter(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        keys.includes(p.name.getText(sf)),
    )
    .map((p) => p.getText(sf))
    .join(',');
}

function prismaOrgNamed(model: string, predicate: string): boolean {
  if (ORG_KEY.test(predicate) || ORG_COMPOUND.test(predicate)) return true;
  // On the organization model the row's own id IS the organisation.
  if (model === 'organization' && /\bid\b/.test(predicate)) return true;
  return false;
}

// A value bound into the statement: a template `${…}`, a `$1` placeholder, or
// the RLS session's organisation.
const BOUND = String.raw`(?:\$\{[^}]*\}|\$\d+|current_org_id\(\))`;
const ORG_COLUMN = String.raw`(?:\w+\.)?organization_id`;
const ORG_PREDICATE = new RegExp(
  `${ORG_COLUMN}\\s*(?:=|IN|=\\s*ANY)\\s*\\(?\\s*${BOUND}|${BOUND}(?:::\\w+)?\\s*=\\s*${ORG_COLUMN}`,
  'i',
);
const ORG_OWN_ID = new RegExp(`(?:\\w+\\.)?\\bid\\s*=\\s*${BOUND}`, 'i');

/**
 * Does a SQL statement restrict its rows to one organisation? Only a
 * PREDICATE counts: organization_id compared with a bound value. Not a
 * projection (`SELECT organization_id …`), an assignment (`SET
 * organization_id = …`), a RETURNING list, or a join that ties two rows'
 * organisations together without naming which (Codex review on #128). An
 * INSERT names the organisation by writing the column, as a Prisma create's
 * `data` does.
 */
function sqlOrgNamed(sql: string, tables: string[]): boolean {
  if (/^\W*INSERT\b/i.test(sql)) return /\borganization_id\b/i.test(sql);
  const predicate = sql
    .replace(/\bRETURNING\b[\s\S]*$/i, ' ')
    .replace(/\bSELECT\b[\s\S]*?\bFROM\b/gi, ' FROM ')
    .replace(/\bSET\b(?!\s+LOCAL)[\s\S]*?(?=\bWHERE\b|\bFROM\b|$)/gi, ' ');
  if (ORG_PREDICATE.test(predicate)) return true;
  // The organizations table's own id is the organisation.
  return tables.includes('organizations') && ORG_OWN_ID.test(predicate);
}

function prismaById(argText: string): boolean {
  // `where: { id }`, `where: { id: x }`, or a compound unique selector.
  return /where\s*:\s*\{[^}]*\bid\b/.test(argText) || /\bwhere\s*:\s*\{\s*id\s*[,}]/.test(argText);
}

/**
 * The SQL text of a template or string, with `${name}` spans replaced by the
 * text of a `const name = '…'` / `` `…` `` declared in an enclosing scope.
 * Raw SQL here is often assembled from fragments (lib/gdpr.ts builds its
 * retention predicate once and reuses it), and a fragment is where the
 * `organization_id` filter may live.
 */
function sqlText(node: ts.Node, sf: ts.SourceFile, depth = 0): string {
  if (!ts.isTemplateExpression(node)) return node.getText(sf);
  let out = node.head.text;
  for (const span of node.templateSpans) {
    let expanded = '${' + span.expression.getText(sf) + '}';
    if (depth < 3 && ts.isIdentifier(span.expression)) {
      const init = constInitializer(span.expression);
      if (init) expanded = sqlText(init, sf, depth + 1);
    }
    out += expanded + span.literal.text;
  }
  return out;
}

function constInitializer(id: ts.Identifier): ts.Expression | null {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (!ts.isBlock(n) && !ts.isSourceFile(n)) continue;
    for (const st of n.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === id.text &&
          d.initializer &&
          (ts.isTemplateExpression(d.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(d.initializer) ||
            ts.isStringLiteral(d.initializer))
        ) {
          return d.initializer;
        }
      }
    }
  }
  return null;
}

const SQL_TABLE =
  /\b(?:from|join|update|into|delete\s+from)\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z_]+)"?/gi;

function sqlTables(sql: string): string[] {
  const found = new Set<string>();
  for (const m of sql.matchAll(SQL_TABLE)) {
    const t = m[1].toLowerCase();
    if (TENANT_TABLES.has(t)) found.add(t);
  }
  return [...found].sort();
}

export function inventory(repoRoot: string): QuerySite[] {
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(repoRoot, r), files);
  const sites: QuerySite[] = [];

  for (const file of files.sort()) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const rel = path.relative(repoRoot, file);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    const visit = (node: ts.Node): void => {
      // Prisma model call: <receiver>.<model>.<op>(args)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        OPS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        TENANT_MODELS[node.expression.expression.name.text]
      ) {
        const model = node.expression.expression.name.text;
        const receiver = node.expression.expression.expression.getText(sf);
        const argText = node.arguments.map((a) => a.getText(sf)).join(',');
        sites.push({
          file: rel,
          line: lineOf(node),
          fn: enclosingFunctionName(node),
          kind: 'prisma',
          target: model,
          op: node.expression.name.text,
          receiver,
          context: contextOf(node, receiver),
          orgNamed: prismaOrgNamed(
            model,
            prismaPredicateText(node.expression.name.text, node.arguments, sf),
          ),
          byId: prismaById(argText),
        });
      }

      // Raw SQL: <receiver>.$queryRaw`…` / $executeRaw`…`, and the Unsafe forms.
      let sql: string | null = null;
      let receiver = '';
      let op = '';
      if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag)) {
        const name = node.tag.name.text;
        if (name === '$queryRaw' || name === '$executeRaw') {
          sql = sqlText(node.template, sf);
          receiver = node.tag.expression.getText(sf);
          op = name;
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['$queryRawUnsafe', '$executeRawUnsafe', '$queryRaw', '$executeRaw'].includes(
          node.expression.name.text,
        ) &&
        node.arguments.length > 0
      ) {
        sql = sqlText(node.arguments[0], sf);
        receiver = node.expression.expression.getText(sf);
        op = node.expression.name.text;
      }
      if (sql !== null) {
        const tables = sqlTables(sql);
        if (tables.length > 0) {
          sites.push({
            file: rel,
            line: lineOf(node),
            fn: enclosingFunctionName(node),
            kind: 'sql',
            target: tables.join('+'),
            op,
            receiver,
            context: contextOf(node, receiver),
            orgNamed: sqlOrgNamed(sql, tables),
            byId: /\bwhere\b[\s\S]*\bid\s*=/i.test(sql),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

function summarise(sites: QuerySite[]): string {
  const lines: string[] = [];
  const count = (f: (s: QuerySite) => boolean) => sites.filter(f).length;
  lines.push(`# Tenant query inventory (${sites.length} call sites)`, '');
  lines.push('| context | names the org | RLS only | of which keyed by id |', '|---|---|---|---|');
  for (const c of ['rls', 'caller-tx', 'bypass', 'app-no-org', 'unknown'] as Context[]) {
    const inC = sites.filter((s) => s.context === c);
    if (!inC.length) continue;
    const named = inC.filter((s) => s.orgNamed).length;
    const unnamed = inC.filter((s) => !s.orgNamed);
    lines.push(`| ${c} | ${named} | ${unnamed.length} | ${unnamed.filter((s) => s.byId).length} |`);
  }
  lines.push('', `Total naming no organisation: ${count((s) => !s.orgNamed)}`, '');
  for (const c of ['bypass', 'unknown', 'caller-tx', 'rls', 'app-no-org'] as Context[]) {
    const rows = sites.filter((s) => s.context === c && !s.orgNamed);
    if (!rows.length) continue;
    lines.push(`## ${c}: names no organisation (${rows.length})`, '');
    lines.push('| site | function | query | by id |', '|---|---|---|---|');
    for (const s of rows) {
      lines.push(
        `| \`${s.file}:${s.line}\` | \`${s.fn}\` | ${s.kind === 'sql' ? 'SQL ' : ''}\`${s.target}.${s.op}\` via \`${s.receiver}\` | ${s.byId ? 'yes' : ''} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  // --root <dir> inventories another checkout (e.g. a branch exported with
  // `git archive`), so open pull requests can be compared with main.
  const rootArg = process.argv.indexOf('--root');
  const root =
    rootArg > 0
      ? path.resolve(process.argv[rootArg + 1])
      : path.resolve(new URL('..', import.meta.url).pathname);
  const sites = inventory(root);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(sites, null, 1) + '\n');
  } else {
    process.stdout.write(summarise(sites) + '\n');
  }
}
