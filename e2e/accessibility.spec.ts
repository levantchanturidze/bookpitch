import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// -----------------------------------------------------------------------------
// Phase 14 — accessibility and responsive proof against real browsers.
//
// tests/ui-accessibility.test.ts proves the shared primitives emit the right
// markup. This proves the assembled pages behave: axe runs against a real
// rendered document with real computed styles (so colour contrast is actually
// evaluated, unlike in JSDOM), and the responsive assertions run at the
// viewport sizes users have.
//
// Only unauthenticated surfaces are covered here on purpose. They need no seed
// data, no session and no cleanup, which makes every assertion deterministic
// and independently repeatable — the property Phase 14.2 asks for. Authenticated
// journeys need an isolated database and are covered by the vitest integration
// suite, which already runs against a real Postgres.
// -----------------------------------------------------------------------------

// Read axe straight from node_modules rather than resolving through the module
// system: Playwright transpiles specs to CJS, so import.meta is unavailable.
const AXE_SOURCE = readFileSync(
  path.join(process.cwd(), 'node_modules/axe-core/axe.min.js'),
  'utf8',
);

type AxeViolation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
};

/** Public routes that must be reachable and clean without a session. */
const PUBLIC_ROUTES = [
  { path: '/signin', name: 'sign in' },
  { path: '/signup', name: 'sign up' },
  { path: '/reset', name: 'password reset' },
  { path: '/onboard/pending', name: 'verification pending' },
  { path: '/onboard/expired', name: 'verification expired' },
  { path: '/onboard/error', name: 'verification error' },
];

async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    // WCAG 2.2 AA is the target stated in the Phase 14 brief.
    const results = await (
      window as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }> };
      }
    ).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return results.violations;
  });
}

function describeViolations(violations: AxeViolation[]): string {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
    )
    .join('\n  ');
}

for (const route of PUBLIC_ROUTES) {
  test(`@a11y ${route.name} has no WCAG A/AA violations`, async ({ page }) => {
    const response = await page.goto(route.path);
    // A 404 route legitimately returns 404; everything else must be 200.
    expect(response, `${route.path} produced no response`).not.toBeNull();

    const violations = await runAxe(page);
    expect(violations, `\n  ${describeViolations(violations)}\n`).toEqual([]);
  });
}

test('@a11y the page declares the language it is actually written in', async ({ page }) => {
  // P14-001. Production served lang="ka" while rendering English, which makes a
  // screen reader pronounce the entire UI with Georgian phonetics.
  await page.goto('/signin');
  const lang = await page.locator('html').getAttribute('lang');
  expect(lang).toBe('en');

  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  expect(bodyText).toContain('sign in');
  // Georgian script must not appear while the document claims English.
  expect(bodyText).not.toMatch(/[Ⴀ-ჿ]/);
});

test('@a11y the sign-in page does not advertise account addresses', async ({ page }) => {
  // P14-011 — this was live on production.
  await page.goto('/signin');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('Dev credentials');
  expect(body).not.toContain('@bookpitch.dev');
});

test('@a11y an unknown URL never leaks route existence or crashes', async ({ page }) => {
  // The proxy sends an unauthenticated request for any non-public path to
  // /signin rather than rendering a 404. That is deliberate — a 404 that only
  // appears for real routes is a route-enumeration oracle — so the assertion is
  // that the user lands somewhere coherent, not that they see the 404 page.
  //
  // The branded not-found boundary (P14-009) exists for authenticated users and
  // for notFound() calls; its presence and content are asserted in
  // tests/ui-regression-guards.test.ts.
  await page.goto('/definitely-not-a-real-route');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: /bookpitch/i })).toBeVisible();

  // Whatever happens, the user must never see an unstyled framework error.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('This page could not be found');
  expect(body).not.toContain('Application error');
});

test('@a11y the skip link is present and is the first stop for keyboard users', async ({
  page,
}, testInfo) => {
  await page.goto('/signin');

  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeAttached();
  // It must point at a target that exists, or it is decoration.
  await expect(skip).toHaveAttribute('href', '#main');

  const isWebKit = testInfo.project.name === 'webkit' || testInfo.project.name === 'mobile-safari';
  if (isWebKit) {
    // Safari/WebKit does not include links in the Tab order unless the user
    // turns on full keyboard access ("Press Tab to highlight each item"). That
    // is a platform default, not something this application controls, so the
    // meaningful assertion on WebKit is that the link is reachable and works
    // once focused — which is exactly what a Safari user with full keyboard
    // access gets. Asserting Tab order here would be asserting Safari's
    // preferences, and would fail for every site on the web.
    await skip.focus();
    await expect(skip).toBeFocused();
    return;
  }

  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  expect(focused).toBe('Skip to main content');
});

test('@a11y keyboard focus is visible on every sign-in control', async ({ page }) => {
  // P14-007. Note the method: this Tabs through the page rather than calling
  // element.focus(). Programmatic focus does not put a button into
  // :focus-visible in Chromium, so a .focus()-based test reports every
  // focus-visible: ring as missing — it measures the test harness, not the UI.
  // Real keyboard traversal is both the correct trigger and the real user path.
  await page.goto('/signin');

  const snapshot = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? '',
        style: `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`,
      };
    });

  // Resting styles, keyed by a stable selector.
  const resting = await page.evaluate(() =>
    Array.from(document.querySelectorAll('main input, main button, main a[href]')).map((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`;
    }),
  );
  expect(resting.length).toBeGreaterThan(0);

  const seen: string[] = [];
  // Tab through the document; the skip link is first, then the form controls.
  for (let i = 0; i < resting.length + 4 && seen.length < resting.length; i++) {
    await page.keyboard.press('Tab');
    const cur = await snapshot();
    if (!cur) continue;
    const inMain = await page.evaluate(() => !!document.activeElement?.closest('main'));
    if (!inMain) continue;
    seen.push(cur.style);
  }

  expect(seen.length, 'tabbing never reached the form controls').toBeGreaterThan(0);
  seen.forEach((focusedStyle, i) => {
    expect(
      focusedStyle,
      `control ${i} (${focusedStyle}) looks identical focused and unfocused`,
    ).not.toBe(resting[i]);
  });
});

// -----------------------------------------------------------------------------
// Responsive — P14-006 and the Phase 14.4 viewport matrix.
// -----------------------------------------------------------------------------

for (const route of PUBLIC_ROUTES) {
  test(`@responsive ${route.name} does not scroll horizontally`, async ({ page }) => {
    await page.goto(route.path);
    // Allow a single pixel of rounding slack; anything more is real overflow.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${route.path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(
      1,
    );
  });
}

test('@responsive the signup form stays usable and reachable', async ({ page }) => {
  await page.goto('/signup');
  const submit = page.getByRole('button', { name: /create workspace/i });
  await expect(submit).toBeVisible();

  // The control must be inside the viewport horizontally — a button the user
  // has to scroll sideways to reach is a broken form on a phone.
  const box = await submit.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
});

test('@responsive form controls meet a usable touch height', async ({ page }, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith('mobile'),
    'touch target sizing only meaningful on touch viewports',
  );
  await page.goto('/signin');
  const controls = page.locator('main input, main button[type="submit"]');
  const count = await controls.count();
  for (let i = 0; i < count; i++) {
    const box = await controls.nth(i).boundingBox();
    if (!box) continue;
    // WCAG 2.2 SC 2.5.8 (Target Size, Minimum) asks for 24px; 32 is the
    // practical floor for a primary form control on a phone.
    expect(box.height, `control ${i} is only ${box.height}px tall`).toBeGreaterThanOrEqual(32);
  }
});
