// -----------------------------------------------------------------------------
// Reachability guard for components/.
//
// F16-004 found seven prototype components under components/ that nothing
// imported. They were never bundled — an unimported module does not reach the
// client — but they carried misleading behaviour: a "Checkout Complete!" screen
// rendering a fabricated `STRIPE_TX_` authorization token from Math.random().
// Dead UI that looks like product is a trap for the next person reading it.
//
// This walks the real import graph from every Next.js entry point and fails if
// anything under components/ is unreachable, so a prototype cannot quietly
// return. Recovery for anything deleted is git history, not an archive folder
// that would still be compiled and linted.
//
// Reachability here means: imported (statically or dynamically) from an entry
// point, or from something an entry point reaches. Test-only imports do not
// count as reachable — a component reachable *only* from a test is still not
// part of the product.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

/** Files Next.js can enter the graph through. */
const ENTRY_BASENAMES = new Set([
  'page.tsx',
  'layout.tsx',
  'route.ts',
  'template.tsx',
  'loading.tsx',
  'error.tsx',
  'not-found.tsx',
  'global-error.tsx',
  'default.tsx',
  'actions.ts',
  'opengraph-image.tsx',
  'icon.tsx',
]);

const ROOT_ENTRIES = ['middleware.ts', 'instrumentation.ts', 'auth.ts'];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function entryPoints(): string[] {
  const entries = walk(path.join(ROOT, 'app')).filter((f) => ENTRY_BASENAMES.has(path.basename(f)));
  for (const r of ROOT_ENTRIES) {
    const full = path.join(ROOT, r);
    if (existsSync(full)) entries.push(full);
  }
  return entries;
}

/** Every module specifier in `src`: static, dynamic, and re-exported. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import … from 'x'  /  export … from 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bnext\/dynamic['"]\s*\)?[\s\S]{0,80}?import\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/** Resolves a specifier to a file on disk, or null for packages. */
function resolve(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // node_modules

  for (const ext of ['', ...EXTENSIONS]) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = path.join(base, 'index' + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function reachableFiles(): Set<string> {
  const seen = new Set<string>();
  const queue = entryPoints();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of specifiers(src)) {
      const target = resolve(spec, file);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

export function unreachableComponents(): string[] {
  const reachable = reachableFiles();
  return walk(path.join(ROOT, 'components'))
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .filter((f) => !reachable.has(f))
    .map((f) => path.relative(ROOT, f))
    .sort();
}

if (process.argv[1] && process.argv[1].includes('check-unreachable-components')) {
  const entries = entryPoints();
  const dead = unreachableComponents();
  console.log(`Scanned ${entries.length} Next.js entry points.`);
  if (dead.length === 0) {
    console.log('All components are reachable.');
    process.exit(0);
  }
  console.error(`\n${dead.length} unreachable component(s):`);
  for (const f of dead) console.error(`  ${f}`);
  console.error(
    '\nUnreachable UI is not shipped, but it reads as product to the next person.\n' +
      'Delete it (git history is the recovery path) or wire it up deliberately.',
  );
  process.exit(1);
}
