// -----------------------------------------------------------------------------
// SEC-008 followup — fail CI when a permission is seeded but no code
// enforces it, unless it's explicitly marked `notYetImplemented`.
//
// The orphan set grew to 20+ over two years because there was no signal.
// This script is the signal. Every merge that adds a new permission key
// to prisma/rbac-seed.ts must either:
//   (a) add a `requirePermission(ctx, 'new.perm.key', …)` or `can(ctx, …)`
//       callsite in the same PR, or
//   (b) tag the P entry with `notYetImplemented: 'bundle_slug'`.
//
// Otherwise CI fails with a specific listing of what's newly orphaned.
//
// Run standalone or via `npm run check:orphan-perms`.
// -----------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

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

function scanSeed(): Array<{ key: string; notYetImplemented: string | null }> {
  const src = readFileSync(path.join(ROOT, 'prisma', 'rbac-seed.ts'), 'utf-8');
  const re = /\{\s*key:\s*'([a-z_]+\.[a-z_.:]+)'[\s\S]*?\}/g;
  const out: Array<{ key: string; notYetImplemented: string | null }> = [];
  for (const m of src.matchAll(re)) {
    const block = m[0];
    const nyi = /notYetImplemented:\s*'([^']+)'/.exec(block);
    out.push({ key: m[1], notYetImplemented: nyi ? nyi[1] : null });
  }
  return out;
}

function scanEnforced(): Set<string> {
  const enforced = new Set<string>();
  const targets = [path.join(ROOT, 'app'), path.join(ROOT, 'lib'), path.join(ROOT, 'auth.ts')];
  const files: string[] = [];
  for (const t of targets) {
    if (statSync(t).isDirectory()) walk(t, files);
    else files.push(t);
  }
  for (const p of files) {
    if (!p.endsWith('.ts') && !p.endsWith('.tsx')) continue;
    if (p.includes(`${path.sep}tests${path.sep}`)) continue;
    const s = readFileSync(p, 'utf-8');
    for (const m of s.matchAll(/requirePermission\s*\([^,]+,\s*['"]([a-z_]+\.[a-z_.:]+)['"]/g)) {
      enforced.add(m[1]);
    }
    for (const m of s.matchAll(/can\s*\(\s*[a-zA-Z_$]+\s*,\s*['"]([a-z_]+\.[a-z_.:]+)['"]/g)) {
      enforced.add(m[1]);
    }
    for (const m of s.matchAll(/perm\(\s*['"]([a-z_]+\.[a-z_.:]+)['"]/g)) {
      enforced.add(m[1]);
    }
  }
  return enforced;
}

function main(): number {
  const seeded = scanSeed();
  const enforced = scanEnforced();

  // A perm is enforced if either its full key OR its base (without :scope)
  // appears in a requirePermission / can() / perm() call. This matches how
  // can() resolves scoped grants at runtime.
  const enforcedBases = new Set<string>();
  for (const k of enforced) enforcedBases.add(k.split(':')[0]);

  const unmarkedOrphans: string[] = [];
  const markedOrphans: Array<{ key: string; bundle: string }> = [];
  for (const { key, notYetImplemented } of seeded) {
    const base = key.split(':')[0];
    const isEnforced = enforced.has(key) || enforcedBases.has(base);
    if (isEnforced) continue;
    if (notYetImplemented) {
      markedOrphans.push({ key, bundle: notYetImplemented });
    } else {
      unmarkedOrphans.push(key);
    }
  }

  console.log(`seeded permissions: ${seeded.length}`);
  console.log(`enforced (callsite): ${enforced.size}`);
  console.log(`marked orphans (notYetImplemented): ${markedOrphans.length}`);
  const bundles: Record<string, number> = {};
  for (const { bundle } of markedOrphans) bundles[bundle] = (bundles[bundle] ?? 0) + 1;
  for (const [b, n] of Object.entries(bundles).sort()) {
    console.log(`  ${b}: ${n}`);
  }

  if (unmarkedOrphans.length > 0) {
    console.error('');
    console.error(`FAIL: ${unmarkedOrphans.length} seeded permission(s) have no`);
    console.error('      requirePermission / can() / perm() callsite AND are not');
    console.error("      marked `notYetImplemented: '<bundle>'` in prisma/rbac-seed.ts.");
    console.error('');
    for (const key of unmarkedOrphans) console.error(`  ${key}`);
    console.error('');
    console.error('Either add a callsite in the same PR OR tag the P entry with a');
    console.error('bundle slug (see the top-of-file comment for existing bundles).');
    console.error('Grant-with-no-enforcement is silent-non-enforcement — SEC-008 class.');
    return 1;
  }

  console.log('OK — no unmarked orphan permissions.');
  return 0;
}

process.exit(main());
