import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// -----------------------------------------------------------------------------
// Phase 14 — repository-level guards for the defect classes this phase fixed.
//
// Each fix below was a whole-codebase sweep, not a one-line change: 72 table
// headers, 12 table wrappers, 7 modals, 3 focus rings. A unit test proves the
// primitive works; these prove nobody quietly reintroduces the old pattern
// somewhere else. That is the difference between fixing a bug and closing a
// defect class.
//
// Every guard names the issue it protects and fails with a message that says
// what to do instead.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'prototype', 'dist', 'coverage']);

function sourceFiles(exts = ['.tsx']): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

const rel = (f: string) => path.relative(ROOT, f);

/**
 * Strip comments before pattern-matching source. Without this, a guard fires on
 * a comment that *quotes* the banned pattern to explain why it is banned —
 * which is exactly what happened here first time round, and would push the next
 * author to describe the old code less clearly to keep the test quiet.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including JSX {/* */} bodies
    .replace(/^\s*\/\/.*$/gm, ''); // line comments
}

/** Components not imported anywhere are unreachable and out of user scope. */
function isReachable(file: string, allSources: string[]): boolean {
  const base = path.basename(file, '.tsx');
  if (base === 'page' || base === 'layout' || base === 'error' || base === 'not-found') return true;
  return allSources.some((other) => {
    if (other === file) return false;
    const src = readFileSync(other, 'utf8');
    return new RegExp(`from '[^']*${base}'`).test(src) || src.includes(`/${base}'`);
  });
}

describe('P14-011 — no credential hints on production pages', () => {
  it('the sign-in page never renders dev credentials unconditionally', () => {
    const src = readFileSync(path.join(ROOT, 'app/(auth)/signin/page.tsx'), 'utf8');
    if (src.includes('Dev credentials')) {
      // It may exist, but only behind a non-production guard.
      expect(src, 'dev credential hint must be gated on NODE_ENV').toMatch(
        /process\.env\.NODE_ENV\s*!==\s*'production'/,
      );
    }
  });

  it('no page advertises an example account address to unauthenticated users', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      // A literal @…dev / @example address rendered outside a NODE_ENV guard.
      const hasAddress = /@bookpitch\.dev|@bookpitch\.test/.test(src);
      if (hasAddress && !/NODE_ENV\s*!==\s*'production'/.test(src)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});

describe('P14-001 — the declared page language matches the rendered language', () => {
  it('the root layout does not default to a language the UI is not written in', () => {
    const src = readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8');
    expect(src).toMatch(/lang=\{process\.env\.LOCALE \?\? 'en'\}/);
  });

  it('the i18n default locale agrees with the root layout', () => {
    const src = readFileSync(path.join(ROOT, 'lib/i18n.ts'), 'utf8');
    expect(src).toMatch(/DEFAULT_LOCALE: Locale = \(process\.env\.LOCALE as Locale\) \?\? 'en'/);
  });
});

describe('P14-002 — every reachable modal goes through ModalShell', () => {
  const OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60';

  it('no reachable component hand-rolls a modal overlay', () => {
    const all = sourceFiles();
    const offenders: string[] = [];
    for (const file of all) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes(OVERLAY)) continue;
      if (src.includes('export default function ModalShell')) continue; // the primitive
      if (!isReachable(file, all)) continue; // dead component, not user-facing
      offenders.push(rel(file));
    }
    expect(
      offenders,
      'reachable components must use components/ui/ModalShell instead of a raw overlay div',
    ).toEqual([]);
  });

  it('ModalShell still provides the four things a dialog needs', () => {
    const src = readFileSync(path.join(ROOT, 'components/ui/ModalShell.tsx'), 'utf8');
    expect(src, 'role').toContain("role: 'dialog'");
    expect(src, 'aria-modal').toContain("'aria-modal': 'true'");
    expect(src, 'Escape').toContain("event.key === 'Escape'");
    expect(src, 'focus restore').toContain('restoreFocusRef.current?.focus?.()');
    expect(src, 'focus trap').toContain("event.key !== 'Tab'");
  });

  it('every ModalShell usage supplies an accessible name', () => {
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<ModalShell\b([^>]*)>/g)) {
        expect(m[1], `${rel(file)} — ModalShell without titleId`).toMatch(/titleId=/);
      }
    }
  });
});

describe('P14-005 / P14-006 — tables are readable and reachable', () => {
  it('every column header carries scope="col"', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<th\b([^>]*)>/g)) {
        if (!/scope=/.test(m[1])) {
          offenders.push(`${rel(file)}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders, 'add scope="col" so screen readers can associate cells').toEqual([]);
  });

  it('every table can be scrolled horizontally on a narrow viewport', () => {
    // `overflow-hidden` on a table wrapper CLIPS columns on mobile with no way
    // to reach them — worse than no wrapper at all. That was the state of 8 of
    // the 12 tables before this phase.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<table\b/g)) {
        const before = src.slice(Math.max(0, m.index - 260), m.index);
        if (!before.includes('overflow-x-auto')) {
          offenders.push(`${rel(file)}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders, 'wrap tables in an overflow-x-auto container').toEqual([]);
  });
});

describe('P14-007 — focus is always visible', () => {
  it('no control removes its focus outline without providing a replacement', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!line.includes('focus:outline-none')) return;
        const replaced = /focus:ring|focus-visible:ring|focus:border|focus-visible:outline/.test(
          line,
        );
        if (!replaced) offenders.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(offenders, 'pair focus:outline-none with a visible focus-visible ring').toEqual([]);
  });
});

describe('P14-008 / P14-009 — error surfaces are complete and safe', () => {
  it('the app error boundary never renders the raw exception message', () => {
    const src = code(path.join(ROOT, 'app/(app)/error.tsx'));
    expect(src, 'raw error.message must not be user-facing').not.toMatch(/\{error\.message\}/);
    expect(src, 'the digest is the safe identifier to surface').toContain('error.digest');
  });

  it('a not-found boundary exists so a bad URL stays inside the product', () => {
    expect(existsSync(path.join(ROOT, 'app/not-found.tsx'))).toBe(true);
  });

  it('a global error boundary exists for failures in the root layout', () => {
    expect(existsSync(path.join(ROOT, 'app/global-error.tsx'))).toBe(true);
  });

  it('neither boundary leaks the raw message', () => {
    for (const f of ['app/global-error.tsx', 'app/(app)/error.tsx']) {
      expect(code(path.join(ROOT, f)), f).not.toMatch(/\{error\.message\}/);
    }
  });

  it('the not-found page is excluded from search indexing', () => {
    const src = readFileSync(path.join(ROOT, 'app/not-found.tsx'), 'utf8');
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});
