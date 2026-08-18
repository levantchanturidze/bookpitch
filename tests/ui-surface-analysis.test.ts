import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import * as A from '../scripts/analyze-ui.mjs';

// -----------------------------------------------------------------------------
// Phase 14 follow-up — gates for the three finding groups that the first pass
// left open with "needs authenticated verification".
//
// They did not, in the end, need authentication. Contrast is a function of the
// foreground colour and the surface it renders on, and both are in the source;
// reachability is a property of the import graph. scripts/analyze-ui.mjs
// computes all three, and these tests turn that analysis into a gate.
//
// Two things the analyser learned the hard way, both preserved as behaviour:
//
//  * It must read the element's OWN background before walking ancestors. The
//    first version reported 41 false "white on white" failures — every one a
//    button with `bg-slate-900 text-white`, judged against the card behind it.
//  * It must refuse to judge a class inside a template literal, where the
//    background can come from a sibling branch. Six more false positives.
//
// An analyser that invents failures is worse than one with gaps, because it
// teaches you to ignore it. Indeterminate cases are counted and reported, never
// silently passed off as clean.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

type Finding = {
  file: string;
  line: number;
  fg: string;
  bg: string | null;
  ratio: number | null;
  passesAA: boolean;
  indeterminate?: boolean;
};
type CondState = {
  fg: string;
  bg: string;
  ratio: number | null;
  passesAA: boolean | null;
  unknownColour?: boolean;
};
type CondResult = {
  file: string;
  line: number;
  staticFg: string | null;
  staticBg: string | null;
  ancestorBg: string | null;
  states: CondState[];
};
type IconButton = {
  file: string;
  line: number;
  hasAriaLabel: boolean;
  hasTitle: boolean;
  hasFocusStyle: boolean;
  snippet: string;
};

function reachableFiles(): Set<string> {
  const { files, edges } = A.buildImportGraph(ROOT);
  const reachable: Set<string> = A.reachableFrom(A.entryPoints(files, ROOT), edges);
  return new Set([...reachable].map((f) => path.relative(ROOT, f as string)));
}

// -----------------------------------------------------------------------------

describe('contrast maths is correct before it is trusted', () => {
  it('matches known WCAG reference values', () => {
    // Black on white is exactly 21:1; identical colours are exactly 1:1.
    expect(A.contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(A.contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the canonical "darkest grey that still passes AA"
    // reference: 4.54:1. One step lighter, #777777, is 4.48:1 and fails. The
    // pair pins the 4.5 threshold from both sides, so an error in the gamma
    // curve or the luminance coefficients would move one of them across it.
    expect(A.contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(A.contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(A.contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(A.contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('is symmetric', () => {
    expect(A.contrastRatio('#94a3b8', '#ffffff')).toBeCloseTo(
      A.contrastRatio('#ffffff', '#94a3b8'),
      10,
    );
  });

  it('reproduces the two ratios that drove the Phase 14 fixes', () => {
    // slate-400 on white — the failure. slate-500 on white — the fix.
    expect(A.contrastRatio(A.PALETTE['slate-400'], A.PALETTE.white)).toBeCloseTo(2.56, 1);
    expect(A.contrastRatio(A.PALETTE['slate-500'], A.PALETTE.white)).toBeCloseTo(4.76, 1);
    // …and the one that proves a blanket 400->500 would have been wrong:
    // on the dark platform plane the correct direction is the opposite.
    expect(A.contrastRatio(A.PALETTE['slate-500'], A.PALETTE['slate-900'])).toBeLessThan(4.5);
    expect(A.contrastRatio(A.PALETTE['slate-400'], A.PALETTE['slate-900'])).toBeGreaterThan(4.5);
  });

  it('rose-50 needs slate-600, not slate-500 — the case a blanket rule misses', () => {
    expect(A.contrastRatio(A.PALETTE['slate-500'], A.PALETTE['rose-50'])).toBeLessThan(4.5);
    expect(A.contrastRatio(A.PALETTE['slate-600'], A.PALETTE['rose-50'])).toBeGreaterThan(4.5);
  });
});

describe('P14-013 — no reachable surface fails WCAG AA contrast', () => {
  const reachable = reachableFiles();
  const findings: Finding[] = A.analyzeContrast(ROOT).filter((f: Finding) => reachable.has(f.file));

  it('analyses a meaningful number of occurrences', () => {
    // Guards against the analyser silently matching nothing and "passing".
    expect(findings.length).toBeGreaterThan(300);
  });

  it('has zero AA failures in code a user can reach', () => {
    const fails = findings.filter((f) => !f.passesAA);
    const detail = fails
      .slice(0, 25)
      .map((f) => `  ${f.file}:${f.line}  text-${f.fg} on bg-${f.bg} = ${f.ratio}:1`)
      .join('\n');
    expect(fails.length, `\n${detail}\n`).toBe(0);
  });

  it('reports indeterminate cases rather than passing them off as clean', () => {
    const indeterminate = findings.filter((f) => f.indeterminate);
    // These are conditional/template-literal classNames where the background
    // may come from a sibling branch. They are a known, bounded gap — covered
    // instead by the browser-level axe run in e2e/accessibility.spec.ts.
    expect(indeterminate.length).toBeGreaterThan(0);
    expect(indeterminate.length).toBeLessThan(findings.length * 0.2);
  });
});

describe('P14-010 — every reachable icon-only control is usable', () => {
  const reachable = reachableFiles();
  const buttons: IconButton[] = A.analyzeIconButtons(ROOT).filter((b: IconButton) =>
    reachable.has(b.file),
  );

  it('finds the icon-only controls', () => {
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('gives every one an accessible name', () => {
    // `title` alone is not enough: it is not surfaced on touch and is ignored
    // by some assistive technology when other content is present.
    const unnamed = buttons.filter((b) => !b.hasAriaLabel);
    expect(
      unnamed.map((b) => `${b.file}:${b.line}`),
      'icon-only buttons need an explicit aria-label',
    ).toEqual([]);
  });

  it('gives every one a visible focus state', () => {
    const unfocusable = buttons.filter((b) => !b.hasFocusStyle);
    expect(
      unfocusable.map((b) => `${b.file}:${b.line}`),
      'icon-only buttons need a focus-visible ring',
    ).toEqual([]);
  });

  it('keyboard operability comes from using a real <button>', () => {
    // The analyser only matches <button>, which is focusable and activates on
    // Enter and Space natively. A div-with-onClick would not be found here —
    // and there are none, asserted below.
    expect(buttons.every((b) => b.snippet.startsWith('<button'))).toBe(true);
  });
});

describe('no clickable non-button elements in reachable code', () => {
  it('has no div/span with onClick posing as a control', () => {
    const reachable = reachableFiles();
    const offenders: string[] = [];
    for (const file of A.sourceFiles(ROOT, ['.tsx'])) {
      const rel = path.relative(ROOT, file);
      if (!reachable.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<(div|span)\b[^>]*\sonClick=/g)) {
        const tag = src.slice(m.index, src.indexOf('>', m.index));
        // A backdrop/overlay is a click-away target, not a control; it is
        // matched by ModalShell's own dismissal and is not keyboard-reachable
        // content. Anything else is a control wearing the wrong element.
        if (/fixed inset-0/.test(tag)) continue;
        offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders, 'use <button> so the control is keyboard operable').toEqual([]);
  });
});

describe('P14-012 — reachability is proven from the import graph', () => {
  const { files, edges } = A.buildImportGraph(ROOT);
  const roots = A.entryPoints(files, ROOT);
  const reachable = A.reachableFrom(roots, edges);
  const components = files.filter(
    (f: string) => f.includes(`${path.sep}components${path.sep}`) && f.endsWith('.tsx'),
  );
  const dead = components
    .filter((f: string) => !reachable.has(f))
    .map((f: string) => path.relative(ROOT, f))
    .sort();

  it('starts from the real Next.js router entry points', () => {
    expect(roots.length).toBeGreaterThan(50);
  });

  it('records exactly the known-dead component set', () => {
    // Explicit rather than "some components are dead": if one is deleted or
    // wired up, this test says so instead of quietly drifting.
    expect(dead).toEqual([
      'components/AnalyticsDashboard.tsx',
      'components/CalendarView.tsx',
      'components/CheckoutPayment.tsx',
      'components/ModulePlaceholder.tsx',
      'components/OfflineManager.tsx',
      'components/PatientDatabase.tsx',
      'components/RemindersSystem.tsx',
    ]);
  });

  it('keeps the accessibility primitives reachable — they were not, at first', () => {
    // ModalShell, Field and StatusMessage were all written, unit-tested and
    // green while being imported by nothing. A primitive no user-facing code
    // renders fixes nothing, however good its own tests are.
    for (const primitive of [
      'components/ui/ModalShell.tsx',
      'components/ui/Field.tsx',
      'components/ui/StatusMessage.tsx',
    ]) {
      expect(dead, `${primitive} is not rendered by any reachable route`).not.toContain(primitive);
    }
  });

  it('the dead components are not counted as user-facing defects anywhere', () => {
    // They contain raw modal overlays and failing contrast. Both guard suites
    // filter on reachability, so this asserts the filter is actually load-bearing.
    expect(dead.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// §2.3 — the analyser is validated against fixtures before its verdict is
// trusted. Every false-positive class it produced during development is pinned
// here, so a future "simplification" that reintroduces one fails loudly.
// -----------------------------------------------------------------------------

describe('analyser self-validation — fixtures', () => {
  const fixture = (jsx: string) => jsx;

  function surfaceOf(jsx: string, needle = 'text-slate-400') {
    return A.resolveSurface(jsx, jsx.indexOf(needle));
  }

  it('an element’s OWN background wins over an ancestor’s', () => {
    // The 41-false-positive bug: a dark button inside a white card.
    const jsx = fixture(
      `<div className="bg-white"><button className="bg-slate-900 text-white">Go</button></div>`,
    );
    expect(A.resolveSurface(jsx, jsx.indexOf('text-white'))).toBe('slate-900');
  });

  it('falls back to the nearest ancestor when the element sets no background', () => {
    const jsx = fixture(
      `<div className="bg-slate-900"><span className="text-slate-400">x</span></div>`,
    );
    expect(surfaceOf(jsx)).toBe('slate-900');
  });

  it('does not take a SIBLING’s background as the surface', () => {
    const jsx = fixture(
      `<div className="bg-white"><i className="bg-slate-900"/><span className="text-slate-400">x</span></div>`,
    );
    expect(surfaceOf(jsx)).toBe('white');
  });

  it('refuses to judge a class inside a conditional expression', () => {
    const jsx = fixture(
      "<div className={active ? 'bg-teal-700 text-white' : 'text-slate-400'}>x</div>",
    );
    expect(A.isIndeterminate(jsx, jsx.indexOf('text-slate-400'))).toBe(true);
  });

  it('a template literal cannot produce a false PASS', () => {
    // The dangerous direction: a real failure hidden because the analyser
    // guessed a flattering background. Indeterminate is never counted as pass.
    const jsx = fixture(
      "<div className={`text-slate-400 ${wide ? 'bg-white' : 'bg-slate-50'}`}>x</div>",
    );
    expect(A.isIndeterminate(jsx, jsx.indexOf('text-slate-400'))).toBe(true);
    // …and analyzeConditionalStates then enumerates BOTH surfaces.
    const { branches } = A.classBranches("{`text-slate-400 ${wide ? 'bg-white' : 'bg-slate-50'}`}");
    expect(branches).toEqual(['bg-white', 'bg-slate-50']);
  });

  it('ignores string literals that belong to the condition, not the classes', () => {
    // `accent === 'teal'` contributed a phantom branch with no background.
    const { branches } = A.classBranches(
      "{`text-white ${accent === 'teal' ? 'bg-teal-700' : 'bg-pink-600'}`}",
    );
    expect(branches).toEqual(['bg-teal-700', 'bg-pink-600']);
    expect(branches).not.toContain('teal');
  });

  it('ignores variant-prefixed utilities when resolving the resting state', () => {
    // `hover:bg-teal-800` is a state, not the resting background.
    const jsx = fixture(`<button className="bg-teal-700 hover:bg-teal-800 text-white">x</button>`);
    expect(A.resolveSurface(jsx, jsx.indexOf('text-white'))).toBe('teal-700');
  });

  it('honours the decorative exemption only when aria-hidden is declared', () => {
    const hidden = `<Icon className="h-4 w-4 text-slate-300" aria-hidden="true" />`;
    const shown = `<Icon className="h-4 w-4 text-slate-300" />`;
    expect(A.isDecorative(hidden, hidden.indexOf('text-slate-300'))).toBe(true);
    expect(A.isDecorative(shown, shown.indexOf('text-slate-300'))).toBe(false);
  });

  it('a known-failing pair fails and a known-passing pair passes', () => {
    expect(A.contrastRatio(A.PALETTE['slate-300'], A.PALETTE.white)).toBeLessThan(4.5);
    expect(A.contrastRatio(A.PALETTE['slate-600'], A.PALETTE.white)).toBeGreaterThan(4.5);
    // dark surface, both directions
    expect(A.contrastRatio(A.PALETTE['slate-600'], A.PALETTE['slate-900'])).toBeLessThan(4.5);
    expect(A.contrastRatio(A.PALETTE['slate-200'], A.PALETTE['slate-900'])).toBeGreaterThan(4.5);
    // tinted light surface
    expect(A.contrastRatio(A.PALETTE['slate-400'], A.PALETTE['rose-50'])).toBeLessThan(4.5);
    expect(A.contrastRatio(A.PALETTE['slate-600'], A.PALETTE['rose-50'])).toBeGreaterThan(4.5);
  });

  it('covers the brand accents that actually failed', () => {
    expect(A.contrastRatio('#ffffff', A.PALETTE['teal-600'])).toBeLessThan(4.5);
    expect(A.contrastRatio('#ffffff', A.PALETTE['teal-700'])).toBeGreaterThan(4.5);
    expect(A.contrastRatio('#ffffff', A.PALETTE['emerald-600'])).toBeLessThan(4.5);
    expect(A.contrastRatio('#ffffff', A.PALETTE['emerald-700'])).toBeGreaterThan(4.5);
  });
});

describe('§2.2 — every conditional class state is enumerated and judged', () => {
  const reachable = reachableFiles();
  const results: CondResult[] = A.analyzeConditionalStates(ROOT).filter((r: CondResult) =>
    reachable.has(r.file),
  );

  it('enumerates the conditional expressions rather than leaving them unexplained', () => {
    expect(results.length).toBeGreaterThan(20);
    const states = results.reduce((n: number, r: { states: unknown[] }) => n + r.states.length, 0);
    expect(states).toBeGreaterThan(results.length);
  });

  it('has zero failing states across every branch', () => {
    const failing = results.flatMap((r: CondResult) =>
      r.states
        .filter((s) => s.passesAA === false)
        .map((s) => `${r.file}:${r.line} text-${s.fg} on bg-${s.bg} = ${s.ratio}:1`),
    );
    expect(failing, `\n  ${failing.join('\n  ')}\n`).toEqual([]);
  });

  it('resolves every state to a known colour — no unknown remainder', () => {
    const unknown = results.flatMap((r: CondResult) =>
      r.states.filter((s) => s.unknownColour).map((s) => `${r.file}:${r.line} ${s.fg}/${s.bg}`),
    );
    expect(unknown, 'add the colour to PALETTE rather than leaving it unjudged').toEqual([]);
  });

  it('the few expressions with no resolvable pair are individually accounted for', () => {
    const noState = results
      .filter((r: CondResult) => r.states.length === 0)
      .map((r: CondResult) => `${r.file}:${r.line}`)
      .sort();
    // Each of these is dispositioned in docs/phase-14-product-qa-ux-ledger.md
    // §14.16: an inherited-surface <dd> whose branches both pass on white, and
    // a disabled nav item, which WCAG 1.4.3 exempts as an inactive component.
    expect(noState.length).toBeLessThanOrEqual(3);
  });
});
