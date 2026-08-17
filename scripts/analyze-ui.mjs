#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Phase 14 — static analysers for the three finding groups that could not be
// closed by the first pass:
//
//   reachability : build the real import graph from app/ entry points and report
//                  which components are actually reachable by a user.
//   contrast     : for every text-slate-* / text-*-400 usage, resolve the
//                  surface it renders on by walking the JSX ancestor chain, then
//                  compute the true WCAG contrast ratio. Context-aware, so a
//                  dark-plane component is judged against its dark background
//                  and never "fixed" into a worse state.
//   icon-buttons : find every <button> whose content is icon-only and report
//                  whether it has an accessible name and a visible focus style.
//
// Used by tests/ui-contrast.test.ts and tests/ui-icon-buttons.test.ts so the
// analysis is a gate, not a one-off report.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.next', '.git', 'prototype', 'dist', 'coverage', 'e2e']);

export function sourceFiles(root, exts = ['.tsx', '.ts']) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  };
  walk(root);
  return out;
}

// -----------------------------------------------------------------------------
// Reachability — a real import graph, not a substring search.
// -----------------------------------------------------------------------------

/** Resolve an import specifier to a file on disk, or null if it is external. */
function resolveImport(spec, fromFile, root) {
  let base;
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // package import

  for (const cand of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ]) {
    try {
      if (readdirSync(path.dirname(cand)).includes(path.basename(cand))) return cand;
    } catch {
      /* directory does not exist */
    }
  }
  return null;
}

export function buildImportGraph(root) {
  const files = sourceFiles(root);
  const edges = new Map(); // file -> Set(file)
  const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const targets = new Set();
    for (const re of [IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const resolved = resolveImport(m[1], file, root);
        if (resolved) targets.add(resolved);
      }
    }
    edges.set(file, targets);
  }
  return { files, edges };
}

/**
 * Next.js App Router entry points: anything the router itself can render.
 * Everything reachable from these is live; everything else is dead code.
 */
export function entryPoints(files, root) {
  const APP = path.join(root, 'app');
  const ROUTER_FILES = new Set([
    'page.tsx',
    'layout.tsx',
    'error.tsx',
    'global-error.tsx',
    'not-found.tsx',
    'loading.tsx',
    'route.ts',
    'template.tsx',
    'default.tsx',
    'icon.tsx',
    'opengraph-image.tsx',
  ]);
  const roots = files.filter(
    (f) => f.startsWith(APP + path.sep) && ROUTER_FILES.has(path.basename(f)),
  );
  // Root-level framework files that also execute at runtime.
  for (const extra of ['proxy.ts', 'auth.ts', 'auth.config.ts', 'instrumentation.ts']) {
    const p = path.join(root, extra);
    if (files.includes(p)) roots.push(p);
  }
  return roots;
}

export function reachableFrom(roots, edges) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) stack.push(next);
  }
  return seen;
}

// -----------------------------------------------------------------------------
// Contrast — real WCAG maths against the resolved surface.
// -----------------------------------------------------------------------------

/** Tailwind v4 default palette, the subset this product actually uses. */
export const PALETTE = {
  white: '#ffffff',
  'slate-50': '#f8fafc',
  'slate-100': '#f1f5f9',
  'slate-200': '#e2e8f0',
  'slate-400': '#94a3b8',
  'slate-500': '#64748b',
  'slate-600': '#475569',
  'slate-700': '#334155',
  'slate-800': '#1e293b',
  'slate-900': '#0f172a',
  'slate-950': '#020617',
  'rose-50': '#fff1f2',
  'amber-50': '#fffbeb',
  'emerald-50': '#ecfdf5',
};

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Walk the JSX ancestor chain upward from `index` and return the nearest
 * background class in scope. Tracks element depth so a sibling's background is
 * never mistaken for an ancestor's.
 */
/**
 * True when the class at `index` sits inside a template literal or a
 * conditional expression, where the background may be supplied by a *sibling
 * branch* the analyser cannot see. e.g.
 *
 *   className={active ? 'bg-teal-600 text-white' : 'text-slate-500'}
 *
 * Reading only the enclosing tag reports that as white-on-white. Six such
 * occurrences were flagged on the first run and every one was a false positive.
 * Rather than guess, these are reported as INDETERMINATE and excluded from the
 * failure set — an analyser that invents failures is worse than one with gaps,
 * because it trains you to ignore it.
 */
export function isIndeterminate(src, index) {
  const tagStart = src.lastIndexOf('<', index);
  if (tagStart === -1) return false;
  // Find the className attribute value containing this index.
  const region = src.slice(tagStart, index);
  const lastClassName = region.lastIndexOf('className=');
  if (lastClassName === -1) return false;
  const between = region.slice(lastClassName);
  // A `{` immediately after className= means an expression, not a plain string.
  if (!/className=\{/.test(between)) return false;
  return between.includes('`') || between.includes('?') || between.includes('&&');
}

export function resolveSurface(src, index) {
  // FIRST: the element the class is actually on. A button written as
  // `className="bg-slate-900 text-white"` carries its own surface, and looking
  // only at ancestors reported it as white-on-white — 41 false failures on the
  // first run. The element's own background always wins.
  const tagStart = src.lastIndexOf('<', index);
  if (tagStart !== -1) {
    const tagEnd = src.indexOf('>', index);
    const ownTag = src.slice(tagStart, tagEnd === -1 ? index : tagEnd);
    const own = /\bbg-(white|slate-\d{2,3}|rose-\d{2,3}|amber-\d{2,3}|emerald-\d{2,3})\b/.exec(
      ownTag,
    );
    if (own) return own[1];
  }

  const before = src.slice(0, index);
  // Depth relative to the occurrence: every unclosed opening tag above us is an
  // ancestor. Walk backwards, incrementing on a close and decrementing on an
  // open; when depth goes negative we have found an enclosing element.
  let depth = 0;
  const tagRe = /<\/?([A-Za-z][\w.]*)\b([^>]*?)(\/?)>/g;
  const tags = [];
  let m;
  while ((m = tagRe.exec(before))) {
    tags.push({ closing: m[0][1] === '/', selfClosing: m[3] === '/', attrs: m[2], raw: m[0] });
  }
  for (let i = tags.length - 1; i >= 0; i--) {
    const t = tags[i];
    if (t.selfClosing) continue;
    if (t.closing) {
      depth++;
      continue;
    }
    if (depth > 0) {
      depth--;
      continue;
    }
    // This is an enclosing ancestor.
    const bg = /\bbg-(white|slate-\d{2,3}|rose-\d{2,3}|amber-\d{2,3}|emerald-\d{2,3})\b/.exec(
      t.attrs,
    );
    if (bg) return bg[1];
  }
  return null;
}

const TEXT_RE = /\btext-(slate-\d{3}|white)\b/g;

export function analyzeContrast(root) {
  const findings = [];
  for (const file of sourceFiles(root, ['.tsx'])) {
    const src = readFileSync(file, 'utf8');
    TEXT_RE.lastIndex = 0;
    let m;
    while ((m = TEXT_RE.exec(src))) {
      const fgKey = m[1];
      const fg = PALETTE[fgKey];
      if (!fg) continue;
      if (isIndeterminate(src, m.index)) {
        findings.push({
          file: path.relative(root, file),
          line: src.slice(0, m.index).split('\n').length,
          fg: fgKey,
          bg: null,
          ratio: null,
          passesAA: true,
          indeterminate: true,
        });
        continue;
      }
      const surface = resolveSurface(src, m.index);
      if (!surface) continue; // no surface in scope — inherits, cannot judge
      const bg = PALETTE[surface];
      if (!bg) continue;
      const ratio = contrastRatio(fg, bg);
      findings.push({
        file: path.relative(root, file),
        absFile: file,
        index: m.index,
        length: m[0].length,
        line: src.slice(0, m.index).split('\n').length,
        fg: fgKey,
        bg: surface,
        ratio: Number(ratio.toFixed(2)),
        passesAA: ratio >= 4.5,
      });
    }
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Icon-only buttons.
// -----------------------------------------------------------------------------

/** Lucide icon components used in this product render an <svg> with no text. */
const ICON_RE = /<([A-Z][A-Za-z0-9]*)\s[^>]*className="[^"]*h-\d/;

export function analyzeIconButtons(root) {
  const results = [];
  for (const file of sourceFiles(root, ['.tsx'])) {
    const src = readFileSync(file, 'utf8');
    // Match a <button ...> ... </button> block, non-greedy, no nested buttons.
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1];
      const body = m[2];
      // Strip tags, then strip only those JSX expressions that render NOTHING
      // visible. `{isPending ? 'Running…' : 'Run tick'}` renders text and must
      // count as a label — treating every {...} as invisible produced six false
      // "icon-only" reports on the first run, each of which had a perfectly
      // good visible label.
      const withoutTags = body.replace(/<[^>]*>/g, ' ');
      const textOnly = withoutTags
        .replace(/\{([^{}]*)\}/g, (whole, inner) =>
          // keep it if the expression contains a string literal — that is text
          /['"`][^'"`]*[A-Za-z][^'"`]*['"`]/.test(inner) ? ' TEXT ' : ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();
      const hasIcon = ICON_RE.test(body) || /<svg\b/.test(body);
      if (!hasIcon) continue;
      if (textOnly.length > 0) continue; // has a visible text label
      results.push({
        file: path.relative(root, file),
        line: src.slice(0, m.index).split('\n').length,
        hasAriaLabel: /aria-label=/.test(attrs),
        hasTitle: /\btitle=/.test(attrs),
        hasFocusStyle: /focus-visible:|focus:ring|focus:outline/.test(attrs),
        snippet: m[0].slice(0, 70).replace(/\s+/g, ' '),
      });
    }
  }
  return results;
}
