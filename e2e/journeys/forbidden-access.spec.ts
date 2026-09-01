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
 * Denial is either a redirect away from the URL, or a 403 carrying the
 * access-denied screen.
 *
 * P17-013, fixed 2026-09-01. This used to accept "an error response whose body
 * does not contain the protected page", because that was all production could
 * manage: `app/(app)/error.tsx` dispatched on `error.name === 'ForbiddenError'`
 * and Next strips the name from errors forwarded to the client in a production
 * build, so a denied user got HTTP 500 and "Something went wrong".
 *
 * The guard now calls Next's `forbidden()` (lib/rbac/page-guard.ts), which
 * renders `app/(app)/forbidden.tsx` with a 403. So this asserts the outcome
 * rather than tolerating the defect:
 *
 *   • the status is exactly 403 — a 500 fails here now;
 *   • the access-denied panel is present;
 *   • the generic server-error copy is absent, which is the assertion that
 *     would have caught the old behaviour;
 *   • the response names no permission, so the refusal leaks nothing.
 */
async function expectDenied(page: import('@playwright/test').Page, url: string) {
  const res = await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  const landedElsewhere = new URL(page.url()).pathname !== url;
  if (landedElsewhere) return;

  const status = res?.status() ?? 0;
  expect(status, `${url} returned ${status} — a denial must be 403, not a server error`).toBe(403);

  await expect(
    page.getByText(/operational access lock/i).first(),
    `${url} returned 403 but rendered no access-denied panel`,
  ).toBeVisible({ timeout: 15_000 });

  // The complement. Without it, a 403 that rendered the generic error page
  // would pass — which is exactly the state this test used to accept.
  await expect(
    page.getByText(/something went wrong/i),
    `${url} rendered the generic server-error page instead of the denial`,
  ).toHaveCount(0);

  // The panel is shown to the refused user; it must not tell them which
  // permission gates the page.
  await expect(page.getByText(/missing permission/i)).toHaveCount(0);
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

  test('@journey /patients is refused — F16-012 revoked client.read:contact', async ({ page }) => {
    // This test used to assert the opposite, as the complement for the three
    // denials above, and it passed for two compounding reasons: F16-012 had
    // already revoked MARKETING's client.read:contact, so the page was in fact
    // refused; and the refusal rendered as a 500 whose error page still keeps
    // the URL, still sits inside <main>, and — because error.name does not
    // survive to the client — never contained the words it looked for. Three
    // assertions, all satisfied by a denial they were written to rule out.
    //
    // The complement is now /analytics below, which MARKETING genuinely holds.
    await expectDenied(page, '/patients');
  });

  test('@journey COMPLEMENT: /analytics IS reachable, so the checks are not vacuous', async ({
    page,
  }) => {
    // Without this, "everything is denied" would pass every test above even if
    // the session were broken and every page redirected to /signin. /analytics
    // is MARKETING's landing (lib/rbac/landing.ts) and report.branch authorises
    // it, so this is the one surface that must render.
    const res = await page.goto('/analytics');
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/analytics');
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.getByText(/operational access lock/i)).toHaveCount(0);
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
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
