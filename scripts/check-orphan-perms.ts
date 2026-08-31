// -----------------------------------------------------------------------------
// SEC-008 followup — fail CI when a permission is seeded but nothing enforces
// it, unless it is explicitly marked `notYetImplemented`.
//
// The orphan set grew to 20+ over two years because there was no signal. This
// script is the signal. Every merge that adds a permission key to
// prisma/rbac-seed.ts must either:
//   (a) add a real authorization callsite in the same PR, or
//   (b) tag the entry with `notYetImplemented: '<bundle_slug>'`.
//
// -----------------------------------------------------------------------------
// P17-006 — what "enforced" means, and why the previous answer was wrong.
//
// The previous implementation scanned with three regexes, one of which was
// `perm\(\s*['"]<key>['"]`. That matched ANY textual occurrence of `perm('x')`,
// including the entries of `RESTRICTED_DURING_IMPERSONATION` in
// lib/rbac/impersonation.ts. Appearing in a DENY list is the opposite of being
// enforced: it proves only that IF some protected operation checked the key,
// impersonation would not be allowed to reach it. Five keys were counted as
// enforced on that basis alone — `org.delete`, `platform.billing.manage`,
// `clinical_note.create`, `clinical_note.attachment.manage` and
// `clinical_note.read:own` — and `platform.billing.manage` was simultaneously
// tagged `notYetImplemented`, a contradiction the old script silently dropped
// from its deferred count (it printed 19 for 20 tagged keys).
//
// The regexes also matched inside comments: `lib/rbac/guard.ts` documents its
// own usage as `requirePermission(ctx, 'booking.update', …)` in a docstring,
// and lib/rbac/toggles.ts names three keys in JSDoc. And they MISSED real
// callsites, because `can\(\s*[a-zA-Z_$]+\s*,` requires a bare identifier as
// the first argument — so `can(v.ctx, 'clinical_note.read:any', …)` in
// lib/customers.ts, which is the actual enforcement point for the clinical
// tier, was invisible.
//
// This version parses each file with the TypeScript compiler and looks at call
// expressions, so comments and string-shaped data can no longer masquerade as
// enforcement. A reference counts as ENFORCEMENT only when the key is passed to
// something that ASKS whether the caller holds it:
//
//   requirePermission(ctx, 'key', …)          → throws ForbiddenError on deny
//   can(<anything>, 'key', …)                 → authorization decision
//   ctx.permissions.has(perm('key'))          → direct membership test
//   ctx.platformPermissions.has(perm('key'))  → ditto
//
// Everything else is a NON-enforcement reference and is ignored: deny-list and
// metadata declarations, seed data, classification tables, equality comparisons
// in a grant/elevation table (`p === perm('report.branch')` in can.ts grants,
// it does not refuse), comments, docs, and tests.
// -----------------------------------------------------------------------------
// Scope resolution mirrors lib/rbac/can.ts rather than approximating it.
//
// can() resolves the four SCOPE suffixes from a base key: given `booking.read`
// it checks `booking.read:org`, then `:branch`, then `:own`. So a seeded
// `booking.read:branch` IS enforced by a `requirePermission(ctx,
// 'booking.read')` callsite.
//
// The TIER suffixes are not resolved that way. `can(ctx, 'client.read:contact')`
// falls through to the exact-match branch, so a seeded `client.read:basic` is
// NOT reachable from a `client.read:contact` callsite. Treating tiers like
// scopes is what previously hid `client.read:basic` and `clinical_note.read:own`
// in the enforced column.
//
// tests/orphan-perms-model.test.ts pins this model against can() itself: if
// can()'s resolution ever changes, that test fails before this script starts
// reporting fiction.
// -----------------------------------------------------------------------------
// POLICY — what fails CI.
//
//   ENFORCED             seeded + at least one enforcement callsite.   ok
//   EXPLICITLY_DEFERRED  seeded + tagged + no enforcement callsite.    ok
//   ORPHAN               seeded + neither.                            FAIL
//   INCONSISTENT         seeded + tagged + enforced anyway.            FAIL
//
// ORPHAN fails because a grant nothing checks is silent non-enforcement — the
// SEC-008 class. INCONSISTENT fails because the seed and the code disagree
// about whether a feature exists, and whichever one a reader trusts, the other
// is lying.
//
// Run standalone or via `npm run check:orphan-perms`.
// -----------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

/** Suffixes can() resolves from a base key (lib/rbac/can.ts steps 4a–4c). */
export const SCOPE_SUFFIXES: ReadonlySet<string> = new Set(['own', 'branch', 'org', 'platform']);
/** Suffixes can() only ever matches exactly (lib/rbac/can.ts step 4d). */
export const TIER_SUFFIXES: ReadonlySet<string> = new Set([
  'limited',
  'unlimited',
  'basic',
  'contact',
  'full',
]);

/** Receivers whose `.has(perm('x'))` is a permission test rather than a set literal. */
const PERMISSION_SET_NAMES: ReadonlySet<string> = new Set(['permissions', 'platformPermissions']);

export type Reference = { file: string; line: number; form: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (['node_modules', '.next', '.git'].some((s) => full.includes(s))) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * The permission key an argument denotes, or null when it is not a literal.
 * Accepts both the bare string and the branded `perm('…')` wrapper. Template
 * literals (`perm(`${p}:org`)` inside can() itself) deliberately yield null —
 * they name no specific key.
 */
function keyFromArgument(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'perm'
  ) {
    const inner = node.arguments[0];
    if (inner && ts.isStringLiteral(inner)) return inner.text;
  }
  return null;
}

/** Every enforcement reference in app/, lib/ and auth.ts, keyed by permission. */
export function scanEnforcement(): Map<string, Reference[]> {
  const found = new Map<string, Reference[]>();
  const targets = [path.join(ROOT, 'app'), path.join(ROOT, 'lib'), path.join(ROOT, 'auth.ts')];
  const files: string[] = [];
  for (const t of targets) {
    if (statSync(t).isDirectory()) walk(t, files);
    else files.push(t);
  }

  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    if (file.includes(`${path.sep}tests${path.sep}`)) continue;

    const source = readFileSync(file, 'utf-8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const relative = path.relative(ROOT, file);

    const record = (key: string, node: ts.Node, form: string): void => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const list = found.get(key) ?? [];
      list.push({ file: relative, line: line + 1, form });
      found.set(key, list);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;

        // requirePermission(ctx, 'key', …) and can(ctx, 'key', …).
        if (
          ts.isIdentifier(callee) &&
          (callee.text === 'requirePermission' || callee.text === 'can')
        ) {
          const key = keyFromArgument(node.arguments[1]);
          if (key) record(key, node, callee.text);
        }

        // ctx.permissions.has(perm('key')) — a membership test used as a gate.
        // Restricted to the two permission-set property names so that
        // RESTRICTED_DURING_IMPERSONATION.has(…) and other Set lookups are not
        // mistaken for authorization.
        else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'has') {
          const receiver = callee.expression;
          const receiverName = ts.isPropertyAccessExpression(receiver)
            ? receiver.name.text
            : ts.isIdentifier(receiver)
              ? receiver.text
              : null;
          const key = keyFromArgument(node.arguments[0]);
          if (key && receiverName && PERMISSION_SET_NAMES.has(receiverName)) {
            record(key, node, `${receiverName}.has`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }
  return found;
}

export type SeededPermission = { key: string; notYetImplemented: string | null };

export function scanSeed(): SeededPermission[] {
  const src = readFileSync(path.join(ROOT, 'prisma', 'rbac-seed.ts'), 'utf-8');
  const re = /\{\s*key:\s*'([a-z_]+\.[a-z_.:]+)'[\s\S]*?\}/g;
  const out: SeededPermission[] = [];
  for (const m of src.matchAll(re)) {
    const nyi = /notYetImplemented:\s*'([^']+)'/.exec(m[0]);
    out.push({ key: m[1], notYetImplemented: nyi ? nyi[1] : null });
  }
  return out;
}

/**
 * Whether `key` is reachable from some enforcement callsite, using can()'s own
 * resolution rules. Exported shape is mirrored by tests/orphan-perms-model.test.ts.
 */
export function isEnforced(key: string, enforcedKeys: ReadonlySet<string>): boolean {
  if (enforcedKeys.has(key)) return true;
  const colon = key.lastIndexOf(':');
  if (colon < 0) return false;
  const suffix = key.slice(colon + 1);
  // Only scope suffixes are resolved from the base by can(); tiers are exact.
  if (SCOPE_SUFFIXES.has(suffix)) return enforcedKeys.has(key.slice(0, colon));
  if (TIER_SUFFIXES.has(suffix)) return false;
  return false;
}

export type Classification = 'ENFORCED' | 'EXPLICITLY_DEFERRED' | 'ORPHAN' | 'INCONSISTENT';

export type Buckets = Record<Classification, SeededPermission[]>;

/** Pure classification step, exported so tests can drive it with fixtures. */
export function classify(
  seeded: readonly SeededPermission[],
  enforcedKeys: ReadonlySet<string>,
): Buckets {
  const buckets: Buckets = {
    ENFORCED: [],
    EXPLICITLY_DEFERRED: [],
    ORPHAN: [],
    INCONSISTENT: [],
  };
  for (const entry of seeded) {
    const enforced = isEnforced(entry.key, enforcedKeys);
    if (enforced && entry.notYetImplemented) buckets.INCONSISTENT.push(entry);
    else if (enforced) buckets.ENFORCED.push(entry);
    else if (entry.notYetImplemented) buckets.EXPLICITLY_DEFERRED.push(entry);
    else buckets.ORPHAN.push(entry);
  }
  return buckets;
}

export function main(): number {
  const seeded = scanSeed();
  const references = scanEnforcement();
  const enforcedKeys = new Set(references.keys());

  const buckets = classify(seeded, enforcedKeys);

  console.log(`seeded permissions:      ${seeded.length}`);
  console.log(`ENFORCED:                ${buckets.ENFORCED.length}`);
  console.log(`EXPLICITLY_DEFERRED:     ${buckets.EXPLICITLY_DEFERRED.length}`);
  console.log(`ORPHAN / UNACCOUNTED:    ${buckets.ORPHAN.length}`);
  console.log(`INCONSISTENT:            ${buckets.INCONSISTENT.length}`);
  console.log(`distinct enforcement callsite keys: ${enforcedKeys.size}`);

  const bundles: Record<string, string[]> = {};
  for (const e of buckets.EXPLICITLY_DEFERRED) {
    (bundles[e.notYetImplemented as string] ??= []).push(e.key);
  }
  console.log('\ndeferred bundles:');
  for (const [bundle, keys] of Object.entries(bundles).sort()) {
    console.log(`  ${bundle}: ${keys.length} (${keys.join(', ')})`);
  }

  let failed = false;

  if (buckets.INCONSISTENT.length > 0) {
    failed = true;
    console.error('');
    console.error(`FAIL: ${buckets.INCONSISTENT.length} permission(s) are tagged`);
    console.error('      `notYetImplemented` but ARE enforced by real callsites.');
    console.error('      The seed and the code disagree about whether the feature exists.');
    console.error('');
    for (const e of buckets.INCONSISTENT) {
      console.error(`  ${e.key}  [bundle: ${e.notYetImplemented}]`);
      for (const r of references.get(e.key) ?? []) {
        console.error(`      enforced at ${r.file}:${r.line} (${r.form})`);
      }
    }
    console.error('');
    console.error('Drop the notYetImplemented tag — the permission is implemented.');
  }

  if (buckets.ORPHAN.length > 0) {
    failed = true;
    console.error('');
    console.error(`FAIL: ${buckets.ORPHAN.length} seeded permission(s) have no`);
    console.error('      authorization callsite AND are not marked');
    console.error("      `notYetImplemented: '<bundle>'` in prisma/rbac-seed.ts.");
    console.error('');
    for (const e of buckets.ORPHAN) console.error(`  ${e.key}`);
    console.error('');
    console.error('Either add a real callsite in the same PR OR tag the entry with a');
    console.error('bundle slug (see the top-of-file comment for what counts as a');
    console.error('callsite). A reference from a deny list, a comment, or a metadata');
    console.error('table is NOT enforcement.');
    console.error('Grant-with-no-enforcement is silent non-enforcement — SEC-008 class.');
  }

  if (failed) return 1;
  console.log('\nOK — every seeded permission is either enforced or explicitly deferred.');
  return 0;
}

// Run as a CLI only. Importing this module (tests/orphan-perms-model.test.ts)
// must not terminate the process.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exit(main());
