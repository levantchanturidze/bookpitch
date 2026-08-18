import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The component markup is rendered by scripts/render-a11y-fixtures.tsx in a
// separate process. Playwright's test transform wraps React elements in its own
// component-testing objects, so calling React.createElement inside a spec fails
// with "Objects are not valid as a React child". Rendering out-of-process keeps
// the markup genuinely produced by the real components.
const FIXTURES: Record<string, string> = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/render-a11y-fixtures.tsx'], {
    encoding: 'utf8',
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  }),
);

// -----------------------------------------------------------------------------
// Phase 14 §2.1 — runtime accessibility for states the public routes cannot show.
//
// e2e/accessibility.spec.ts scans six public pages in six browsers. Those pages
// have no dialog, no validation-error state, no populated table and no empty
// state, so axe has never seen those surfaces with real computed styles.
//
// Authenticating to reach them is not something I will do — it means entering a
// password — and it is not necessary: the components that carry the
// accessibility contract can be rendered directly and mounted in a real browser
// with the application's real compiled stylesheet. That gives axe genuine
// computed colours, so `color-contrast` actually runs, unlike in JSDOM.
//
// What is real here: the components, their props, the stylesheet, the browser,
// the computed styles. What is representative: the surrounding page chrome and
// the table rows, which use the product's own class strings but synthetic data.
// No production data is used anywhere.
// -----------------------------------------------------------------------------

type AxeViolation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
};

const AXE_SOURCE = readFileSync(
  path.join(process.cwd(), 'node_modules/axe-core/axe.min.js'),
  'utf8',
);

/** The compiled Tailwind stylesheet produced by `next build`. */
function appStylesheet(): string {
  // Next 16 emits CSS under .next/static/immutable/chunks, not .next/static/css,
  // and the exact directory is an implementation detail that has moved between
  // versions — so search rather than hard-code it.
  const root = path.join(process.cwd(), '.next/static');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.css')) found.push(full);
    }
  };
  walk(root);
  if (found.length === 0) {
    throw new Error('no compiled CSS under .next/static — run `npm run build` first');
  }
  return found.map((f) => readFileSync(f, 'utf8')).join('\n');
}

async function mount(page: Page, bodyHtml: string, bodyClass = 'bg-white') {
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>harness</title></head>` +
      `<body class="${bodyClass}"><main id="main">${bodyHtml}</main></body></html>`,
  );
  await page.addStyleTag({ content: appStylesheet() });
}

async function axeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const results = await (
      window as unknown as {
        axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> };
      }
    ).axe.run(document, {
      // Full WCAG 2.2 AA. Nothing is disabled — in particular color-contrast
      // runs here, which is the whole point of using a real browser.
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return results.violations;
  });
}

function describeViolations(v: AxeViolation[]): string {
  return v
    .map(
      (x) =>
        `${x.id} (${x.impact}): ${x.help}\n      ${x.nodes.map((n) => n.target.join(' ')).join('\n      ')}`,
    )
    .join('\n  ');
}

// -----------------------------------------------------------------------------

test('@a11y dialog state — real ModalShell, real styles, contrast enabled', async ({ page }) => {
  const html = FIXTURES.dialog;
  await mount(page, html);
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Edit member');
  const v = await axeViolations(page);
  expect(v, `\n  ${describeViolations(v)}\n`).toEqual([]);
});

test('@a11y validation-error state — real Field with an error', async ({ page }) => {
  const html = FIXTURES.validationError;
  await mount(page, html);

  const input = page.getByRole('textbox', { name: /email/i });
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  // The error text must be reachable from the control, not merely nearby.
  const describedBy = await input.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  for (const id of describedBy!.split(' ')) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  await expect(page.getByRole('alert')).toHaveCount(2); // field error + form status

  const v = await axeViolations(page);
  expect(v, `\n  ${describeViolations(v)}\n`).toEqual([]);
});

test('@a11y status messages — success and error tones', async ({ page }) => {
  const html = FIXTURES.statuses;
  await mount(page, html);
  await expect(page.getByRole('status')).toHaveCount(3);
  await expect(page.getByRole('alert')).toHaveCount(1);
  const v = await axeViolations(page);
  expect(v, `\n  ${describeViolations(v)}\n`).toEqual([]);
});

test('@a11y data table and empty state use the product’s own classes', async ({ page }) => {
  // Class strings copied verbatim from components/settings/MembersPanel.tsx and
  // the empty state in components/patients/PatientList.tsx, with synthetic rows.
  const table = `
    <div class="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full text-left text-xs">
        <caption class="sr-only">Organisation members</caption>
        <thead class="border-b border-slate-100 bg-slate-50 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
          <tr>
            <th scope="col" class="px-6 py-2 font-medium">Name</th>
            <th scope="col" class="px-2 py-2 font-medium">Role</th>
            <th scope="col" class="px-6 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr>
            <td class="px-6 py-2 font-bold text-slate-800">E2E-PHASE14-Member</td>
            <td class="px-2 py-2 text-slate-600">Front Desk</td>
            <td class="px-6 py-2 text-right">
              <button class="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600">Edit</button>
            </td>
          </tr>
          <tr>
            <td class="px-6 py-2 font-bold text-slate-800">E2E-PHASE14-Owner</td>
            <td class="px-2 py-2 text-slate-600">Owner</td>
            <td class="px-6 py-2 text-right"><span class="text-slate-500">—</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="flex flex-col items-center py-12 text-center text-slate-500">
      <svg class="mb-2 h-8 w-8 stroke-1 text-slate-300" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"/></svg>
      <p class="text-xs">No records match your search.</p>
    </div>`;
  await mount(page, table);
  // Header association is what makes a table navigable by screen reader.
  const headers = page.locator('th');
  await expect(headers).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(headers.nth(i)).toHaveAttribute('scope', 'col');
  const v = await axeViolations(page);
  expect(v, `\n  ${describeViolations(v)}\n`).toEqual([]);
});

test('@a11y the brand accent button meets AA at its real computed colour', async ({ page }) => {
  // P14-015. teal-600 was 3.74:1 with white small text; teal-700 is 5.47:1.
  // Asserted against the real stylesheet so a palette change is caught here.
  await mount(
    page,
    `<div class="p-6">
       <button class="flex items-center gap-1.5 rounded-xl bg-teal-700 p-2 text-xs font-semibold text-white">New patient</button>
       <button class="ml-2 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white">New organization</button>
     </div>`,
  );
  const v = await axeViolations(page);
  const contrast = v.filter((x) => x.id === 'color-contrast');
  expect(contrast, `\n  ${describeViolations(contrast)}\n`).toEqual([]);
});
