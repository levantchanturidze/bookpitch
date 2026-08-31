import { test, expect } from '@playwright/test';
import { storageStatePath } from '../fixtures/roles';

// -----------------------------------------------------------------------------
// Journey 2 — authentication → a forbidden direct URL → correct denial.
//
// CLAUDE.md: "A permission check must have a test that calls the endpoint
// WITHOUT the permission and gets a 403, not just one that succeeds with it."
// The unit suite does that at the service layer. This does it the way an actual
// attacker would: a real signed-in session, typing a URL it has no business
// reaching.
//
// The distinction is not academic. A guard can be present in a route handler
// and skipped by the path that actually runs — a layout that renders before it,
// a client component that fetches around it, a redirect that lands somewhere
// unguarded. Only a browser hitting the URL proves the refusal happens.
// -----------------------------------------------------------------------------

/**
 * Denial is either a redirect away from the URL, or an error response whose
 * body does not contain the protected page.
 *
 * P17-013, measured here: the "Operational Access Lock" panel in
 * app/(app)/error.tsx does NOT render in production. It dispatches on
 * `error.name === 'ForbiddenError'`, and Next.js strips the name and message
 * from errors forwarded to the client in production builds — documented at
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:106.
 * A denied user gets HTTP 500 and the generic "Something went wrong" fallback.
 *
 * The refusal itself is correct: rbac.enforce_deny fires, the status is 5xx and
 * no tenant data is rendered. So this asserts the properties that must hold —
 * the protected content is absent and an error state is shown — rather than
 * pinning the specific copy, which would encode today's defect as tomorrow's
 * expectation.
 */
async function expectDenied(page: import('@playwright/test').Page, url: string) {
  const res = await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  const landedElsewhere = new URL(page.url()).pathname !== url;
  if (landedElsewhere) return;

  const status = res?.status() ?? 0;
  expect(status, `${url} returned ${status} — it was not refused`).toBeGreaterThanOrEqual(400);

  // app/(app)/error.tsx is a client component, so the panel appears only after
  // hydration. Counting immediately after domcontentloaded is a race — it
  // happened to pass on /scheduler and fail on /audit, which is a slower page.
  await expect(
    page.getByText(/access lock|something went wrong/i).first(),
    `${url} returned ${status} but rendered no error state`,
  ).toBeVisible({ timeout: 15_000 });
}

/** True when `url` renders as itself with no error state — i.e. was NOT refused. */
async function isReachable(page: import('@playwright/test').Page, url: string) {
  const res = await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  if (new URL(page.url()).pathname !== url) return false;
  if ((res?.status() ?? 0) >= 400) return false;
  return (await page.getByText(/access lock|something went wrong/i).count()) === 0;
}

test.describe('enforcement is actually on', () => {
  test.use({ storageState: storageStatePath('MARKETING') });

  test('@journey the guard layer is enforcing, not shadowing', async ({ page }) => {
    // lib/rbac/guard.ts::isEnforcing returns false when RBAC_ENFORCE_MODULES is
    // unset, and requirePermission then only logs `rbac.shadow_deny` and lets
    // the request through. Every denial below would pass through to a rendered
    // page and this whole file would be measuring nothing.
    //
    // This ran that way once, locally, and it is why the check exists: with the
    // variable unset, MARKETING reached /scheduler and /audit and ORG_OWNER
    // reached /platform/orgs. One clear failure here beats four confusing ones.
    expect(
      await isReachable(page, '/scheduler'),
      'MARKETING reached /scheduler — RBAC_ENFORCE_MODULES is unset, so the ' +
        'guard layer is in shadow mode and no denial test in this file means anything.',
    ).toBe(false);
  });
});

test.describe('MARKETING cannot reach the calendar', () => {
  test.use({ storageState: storageStatePath('MARKETING') });

  test('@journey /scheduler is refused — MARKETING holds no booking.read', async ({ page }) => {
    await expectDenied(page, '/scheduler');
  });

  test('@journey /settings is refused — no org.settings.update:org', async ({ page }) => {
    await expectDenied(page, '/settings');
  });

  test('@journey /audit is refused — no audit.read', async ({ page }) => {
    await expectDenied(page, '/audit');
  });

  test('@journey COMPLEMENT: /patients IS reachable, so the check is not vacuous', async ({
    page,
  }) => {
    // Without this, "everything is denied" would pass the three tests above
    // even if the session were broken and every page redirected to /signin.
    await page.goto('/patients');
    expect(new URL(page.url()).pathname).toBe('/patients');
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.getByText(/access locked/i)).toHaveCount(0);
  });
});

test.describe('an org role cannot reach the platform plane', () => {
  test.use({ storageState: storageStatePath('ORG_OWNER') });

  test('@journey /platform is refused for ORG_OWNER', async ({ page }) => {
    // The layout turns ForbiddenError into a redirect to '/', which then sends
    // an org owner to /scheduler. Landing anywhere other than /platform is the
    // denial.
    await page.goto('/platform');
    await page.waitForLoadState('domcontentloaded');
    expect(new URL(page.url()).pathname).not.toBe('/platform');
  });

  test('@journey /platform/orgs is refused for ORG_OWNER', async ({ page }) => {
    await page.goto('/platform/orgs');
    await page.waitForLoadState('domcontentloaded');
    expect(new URL(page.url()).pathname.startsWith('/platform')).toBe(false);
  });

  test('@journey COMPLEMENT: ORG_OWNER does reach its own settings', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.getByText(/access locked/i)).toHaveCount(0);
  });
});

test.describe('a signed-out visitor reaches nothing', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const url of ['/scheduler', '/patients', '/analytics', '/settings', '/audit', '/platform']) {
    test(`@journey ${url} redirects an anonymous visitor to /signin`, async ({ page }) => {
      await page.goto(url);
      await page.waitForURL('**/signin', { timeout: 15_000 });
      expect(new URL(page.url()).pathname).toBe('/signin');
    });
  }
});
