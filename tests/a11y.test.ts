import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import axe, { type AxeResults } from 'axe-core';

// -----------------------------------------------------------------------------
// axe-core smoke test for representative markup:
//   1) The sign-in form (labels, contrast, form-field-multiple-labels).
//   2) A minimal shell page (landmark, skip link, main).
//
// These are hand-inlined HTML strings on purpose — running the real React
// tree through JSDOM would need a full test-lib setup for a first-pass gate.
// Once we add React Testing Library, swap these strings for renderToString
// of the actual components without changing the assertions.
// -----------------------------------------------------------------------------

let dom: JSDOM;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html lang="ka"><body></body></html>', {
    url: 'http://localhost/',
  });
  const g = globalThis as unknown as {
    document: Document;
    window: Window;
    HTMLElement: typeof HTMLElement;
    Element: typeof Element;
    Node: typeof Node;
    getComputedStyle: typeof getComputedStyle;
  };
  g.document = dom.window.document;
  g.window = dom.window as unknown as Window;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.getComputedStyle = dom.window.getComputedStyle;
});

afterAll(() => {
  dom.window.close();
});

async function runAxe(html: string): Promise<AxeResults> {
  dom.window.document.body.innerHTML = html;
  return axe.run(dom.window.document.body, {
    // Rules that need actual pixel rendering (contrast) don't work in JSDOM.
    rules: {
      'color-contrast': { enabled: false },
    },
  });
}

describe('a11y — sign-in form', () => {
  it('has zero WCAG A/AA violations (contrast excluded)', async () => {
    const html = `
      <main id="main">
        <form aria-labelledby="signin-title">
          <h1 id="signin-title">Sign in</h1>
          <label>
            <span>Email</span>
            <input name="email" type="email" required autocomplete="email" />
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" required autocomplete="current-password" />
          </label>
          <button type="submit">Sign in</button>
        </form>
      </main>
    `;
    const result = await runAxe(html);
    if (result.violations.length) {
      // Print the ids for easy debugging.
      console.log('violations:', result.violations.map((v) => v.id));
    }
    expect(result.violations).toEqual([]);
  });
});

describe('a11y — app shell landmarks + skip link', () => {
  it('main region + skip link + nav are all reachable', async () => {
    const html = `
      <a href="#main">Skip to main content</a>
      <header><nav aria-label="Primary"><a href="/scheduler">Scheduler</a></nav></header>
      <main id="main" tabindex="-1">
        <h1>Scheduler</h1>
      </main>
    `;
    const result = await runAxe(html);
    if (result.violations.length) {
      console.log('violations:', result.violations.map((v) => v.id));
    }
    expect(result.violations).toEqual([]);
  });
});
