/* eslint-disable react/no-children-prop --
 * These tests call React.createElement directly because this is a .ts file, not
 * .tsx. ModalShell and Field both declare `children` as a required prop, so
 * TypeScript rejects the varargs form (`createElement(C, props, ...children)`)
 * with "Property 'children' is missing" — the children have to go in the props
 * object for the call to type-check at all.
 *
 * The rule is aimed at application JSX, where `<C children={x} />` is a
 * confusing way to write `<C>{x}</C>`. Neither form exists here. The narrow
 * alternative — renaming this file to .tsx and widening the vitest `include`
 * glob — would change test discovery for the whole suite to satisfy a style
 * rule about JSX in a file that contains none.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import axe, { type AxeResults } from 'axe-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ModalShell from '@/components/ui/ModalShell';
import Field from '@/components/ui/Field';
import StatusMessage, { VisuallyHiddenStatus } from '@/components/ui/StatusMessage';

// -----------------------------------------------------------------------------
// Phase 14 — accessibility regression tests for the shared UI primitives.
//
// The pre-existing tests/a11y.test.ts ran axe over two hand-written HTML
// strings. Its own comment admitted the limitation: "Once we add React Testing
// Library, swap these strings for renderToString of the actual components."
// Until then it could not have caught any of the defects this phase found,
// because it never looked at a real component.
//
// These render the ACTUAL primitives with react-dom/server and assert on the
// emitted markup, so a regression in the component is a failing test rather
// than a passing string comparison.
//
// Behaviour that needs a live DOM — Escape to close, the focus trap, focus
// restoration — is proven in Playwright against real browsers
// (e2e/accessibility.spec.ts). Static semantics are proven here because they
// are cheap and run on every commit.
// -----------------------------------------------------------------------------

let dom: JSDOM;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: 'http://localhost/',
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = dom.window.document;
  g.window = dom.window;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.getComputedStyle = dom.window.getComputedStyle;
});

afterAll(() => {
  dom.window.close();
});

async function axeOn(html: string): Promise<AxeResults> {
  dom.window.document.body.innerHTML = html;
  return axe.run(dom.window.document.body, {
    rules: {
      // `color-contrast` needs real layout and computed colours; JSDOM has
      // neither, so the rule cannot produce a meaningful result here. Contrast
      // is checked instead in e2e/accessibility.spec.ts, which runs axe in a
      // real browser against real rendered pages.
      'color-contrast': { enabled: false },
      // `region` asserts that all content sits inside a landmark. That is a
      // page-level property, and these tests deliberately render a single
      // component in isolation — every fragment would fail it by construction,
      // which would say nothing about the component. Landmark structure is
      // asserted on whole pages in e2e/accessibility.spec.ts.
      region: { enabled: false },
    },
  });
}

function violationIds(results: AxeResults): string[] {
  return results.violations.map((v) => v.id);
}

// -----------------------------------------------------------------------------

describe('P14-002 — ModalShell exposes real dialog semantics', () => {
  const owned = renderToStaticMarkup(
    createElement(ModalShell, {
      titleId: 'dlg-title',
      children: [
        createElement('h2', { id: 'dlg-title', key: 'h' }, 'Edit member'),
        createElement('button', { type: 'button', key: 'b' }, 'Save'),
      ],
    }),
  );

  it('renders role="dialog"', () => {
    expect(owned).toContain('role="dialog"');
  });

  it('marks the dialog modal', () => {
    expect(owned).toContain('aria-modal="true"');
  });

  it('labels the dialog from its own title element', () => {
    expect(owned).toContain('aria-labelledby="dlg-title"');
    expect(owned).toContain('id="dlg-title"');
  });

  it('makes the panel programmatically focusable so focus can be moved into it', () => {
    expect(owned).toContain('tabindex="-1"');
  });

  it('produces no axe violations', async () => {
    const results = await axeOn(owned);
    expect(violationIds(results)).toEqual([]);
  });

  it('adopt mode puts the same semantics on the caller’s own panel', () => {
    // This is the mode all seven migrated modals use: the existing panel keeps
    // its classes and gains the dialog attributes.
    const adopted = renderToStaticMarkup(
      createElement(ModalShell, {
        titleId: 'adopt-title',
        panelClassName: null,
        children: createElement(
          'div',
          { className: 'w-full max-w-lg rounded-xl bg-white p-6' },
          createElement('h2', { id: 'adopt-title' }, 'Booking assistant'),
        ),
      }),
    );
    expect(adopted).toContain('role="dialog"');
    expect(adopted).toContain('aria-modal="true"');
    expect(adopted).toContain('aria-labelledby="adopt-title"');
    // The caller's own classes survive untouched — no visual regression.
    expect(adopted).toContain('w-full max-w-lg rounded-xl bg-white p-6');
  });

  it('does not double-wrap the panel in adopt mode', () => {
    const adopted = renderToStaticMarkup(
      createElement(ModalShell, {
        titleId: 't',
        panelClassName: null,
        children: createElement(
          'div',
          { className: 'panel' },
          createElement('h2', { id: 't' }, 'X'),
        ),
      }),
    );
    // overlay + panel only.
    expect((adopted.match(/<div/g) ?? []).length).toBe(2);
  });
});

describe('P14-004 — Field wires errors to the control', () => {
  function renderField(opts: { error?: string; hint?: string; required?: boolean }) {
    return renderToStaticMarkup(
      createElement(Field, {
        label: 'Email',
        error: opts.error,
        hint: opts.hint,
        required: opts.required,
        children: (props) => createElement('input', { type: 'email', name: 'email', ...props }),
      }),
    );
  }

  it('associates the label with the control', () => {
    const html = renderField({});
    const forMatch = /<label[^>]*for="([^"]+)"/.exec(html);
    const idMatch = /<input[^>]*id="([^"]+)"/.exec(html);
    expect(forMatch).not.toBeNull();
    expect(idMatch).not.toBeNull();
    expect(forMatch![1]).toBe(idMatch![1]);
  });

  it('does not mark a valid field invalid', () => {
    expect(renderField({})).not.toContain('aria-invalid');
  });

  it('marks an errored field aria-invalid — the complement case', () => {
    expect(renderField({ error: 'Enter a valid email address' })).toContain('aria-invalid="true"');
  });

  it('points aria-describedby at the error message', () => {
    const html = renderField({ error: 'Enter a valid email address' });
    const described = /aria-describedby="([^"]+)"/.exec(html);
    expect(described).not.toBeNull();
    for (const id of described![1].split(' ')) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Enter a valid email address');
  });

  it('announces the error via role="alert"', () => {
    expect(renderField({ error: 'boom' })).toContain('role="alert"');
  });

  it('describes by hint and error together, hint first', () => {
    const html = renderField({ hint: 'We never share this', error: 'Required' });
    const described = /aria-describedby="([^"]+)"/.exec(html)![1].split(' ');
    expect(described).toHaveLength(2);
    const hintPos = html.indexOf(`id="${described[0]}"`);
    const errPos = html.indexOf(`id="${described[1]}"`);
    expect(hintPos).toBeGreaterThan(-1);
    expect(errPos).toBeGreaterThan(-1);
    expect(hintPos).toBeLessThan(errPos);
  });

  it('communicates required state to assistive technology, not just visually', () => {
    const html = renderField({ required: true });
    // The asterisk is decorative; the word is what gets announced.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('(required)');
  });

  it('produces no axe violations in either state', async () => {
    expect(violationIds(await axeOn(renderField({})))).toEqual([]);
    expect(violationIds(await axeOn(renderField({ error: 'Required', hint: 'Hint' })))).toEqual([]);
  });
});

describe('P14-003 — status messages reach assistive technology', () => {
  it('uses role="status" and polite live for non-error tones', () => {
    const html = renderToStaticMarkup(
      createElement(StatusMessage, { tone: 'success', children: 'Member updated' }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Member updated');
  });

  it('escalates errors to role="alert" and assertive live', () => {
    const html = renderToStaticMarkup(
      createElement(StatusMessage, { tone: 'error', children: 'Could not save' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });

  it('keeps the live region mounted when empty so later text is announced', () => {
    // A live region inserted at the same moment as its text is frequently
    // missed; the container must already exist.
    const html = renderToStaticMarkup(createElement(StatusMessage, {}));
    expect(html).toContain('aria-live');
    expect(html).toContain('sr-only');
  });

  it('marks the region atomic so the whole message is read', () => {
    const html = renderToStaticMarkup(createElement(StatusMessage, { children: 'x' }));
    expect(html).toContain('aria-atomic="true"');
  });

  it('VisuallyHiddenStatus announces without rendering a visible box', () => {
    const html = renderToStaticMarkup(
      createElement(VisuallyHiddenStatus, { children: '12 results' }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('sr-only');
    expect(html).toContain('12 results');
  });

  it('produces no axe violations', async () => {
    const html = renderToStaticMarkup(
      createElement(StatusMessage, { tone: 'error', children: 'Could not save' }),
    );
    expect(violationIds(await axeOn(html))).toEqual([]);
  });
});
