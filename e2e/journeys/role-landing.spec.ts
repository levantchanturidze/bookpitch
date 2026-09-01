import { test, expect } from '@playwright/test';
import {
  ORG_ROLE_ACCOUNTS,
  PLATFORM_ROLE_ACCOUNTS,
  storageStatePath,
  type E2ERole,
} from '../fixtures/roles';
import { ORG_ROLE_LANDING, PLATFORM_LANDING } from '../../lib/rbac/landing';

// -----------------------------------------------------------------------------
// Journey 1 and Journey 5 — authentication → role landing → an authorised page.
//
// tests/role-landing.test.ts already proves, against the seeded permission
// rows, that each role's landing is one that role's permissions authorise. This
// is the other half: that a real browser, with a real session, actually arrives
// there and gets a rendered page rather than the "Access Locked" panel.
//
// The distinction matters. The unit test would still pass if the shell crashed,
// if the redirect looped, or if requirePermission threw for a reason unrelated
// to the landing permission. Only a browser can tell you the user got a page.
// -----------------------------------------------------------------------------

/** The Access Locked panel a caller sees when requirePermission refuses. */
async function expectNotAccessLocked(page: import('@playwright/test').Page) {
  await expect(page.getByText(/access locked/i)).toHaveCount(0);
}

for (const [role, landing] of Object.entries(ORG_ROLE_LANDING)) {
  const email = ORG_ROLE_ACCOUNTS[role as keyof typeof ORG_ROLE_ACCOUNTS];
  if (!email) continue; // no E2E account for this role

  test.describe(`${role}`, () => {
    test.use({ storageState: storageStatePath(role as E2ERole) });

    test(`@journey lands on ${landing} from the authenticated root`, async ({ page }) => {
      await page.goto('/');
      await page.waitForURL(`**${landing}`, { timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe(landing);
    });

    test(`@journey ${landing} renders for ${role}, not Access Locked`, async ({ page }) => {
      await page.goto(landing);
      await expect(page.locator('main').first()).toBeVisible();
      await expectNotAccessLocked(page);
    });

    test(`@journey the root does not redirect-loop for ${role}`, async ({ page }) => {
      // A loop shows up as a navigation that never settles. `/` → landing is
      // one hop; anything that bounces back to `/` would time out here.
      const responses: string[] = [];
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) responses.push(new URL(f.url()).pathname);
      });
      await page.goto('/');
      await page.waitForURL(`**${landing}`, { timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      // '/' may appear once as the starting point; the landing exactly once
      // after it. Repeats of either mean a bounce.
      expect(responses.filter((p) => p === landing).length).toBeLessThanOrEqual(2);
      expect(responses.filter((p) => p === '/').length).toBeLessThanOrEqual(2);
    });
  });
}

test.describe('PLATFORM_ADMIN', () => {
  test.use({ storageState: storageStatePath('PLATFORM_ADMIN') });

  test('@journey a platform role lands on the platform plane', async ({ page }) => {
    // app/platform/page.tsx forwards a bare /platform to /platform/orgs, so the
    // landing is the plane rather than that exact path. Asserting the literal
    // path would be asserting an implementation detail of the index page.
    await page.goto('/');
    await page.waitForURL('**/platform/**', { timeout: 20_000 });
    expect(new URL(page.url()).pathname.startsWith(PLATFORM_LANDING)).toBe(true);
  });

  test('@journey /platform renders — no ⇄ / redirect loop', async ({ page }) => {
    // app/platform/layout.tsx redirects ForbiddenError back to '/', and '/'
    // sends platform roles to '/platform'. A platform role lacking
    // platform.analytics.read is an infinite redirect, not a 403.
    await page.goto('/platform');
    await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname.startsWith(PLATFORM_LANDING)).toBe(true);
  });
});

test.describe('coverage', () => {
  test('@journey every org role with a landing has a browser account', async () => {
    // If a role is added to lib/rbac/landing.ts without an E2E account, its
    // landing silently stops being exercised in a browser. This is what stops
    // that from being invisible.
    const missing = Object.keys(ORG_ROLE_LANDING).filter((r) => !(r in ORG_ROLE_ACCOUNTS));
    expect(missing, 'add these to e2e/fixtures/roles.ts').toEqual([]);
    expect(Object.keys(PLATFORM_ROLE_ACCOUNTS).length).toBeGreaterThan(0);
  });
});
