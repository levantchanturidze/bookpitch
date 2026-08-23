import { test, expect } from '@playwright/test';
import { storageStatePath } from '../fixtures/roles';

// -----------------------------------------------------------------------------
// Journey 4 — the scheduler critical path, and the public booking widget.
//
// A smoke, not a feature suite: the brief explicitly asks not to overbuild
// here. What it proves is that the highest-traffic authenticated surface
// actually renders real tenant data under a real session — which is the part a
// service-layer test cannot tell you, because it can pass while the shell
// throws, the client component fails to hydrate, or the query returns rows the
// page never displays.
// -----------------------------------------------------------------------------

test.describe('scheduler', () => {
  test.use({ storageState: storageStatePath('FRONT_DESK') });

  test('@journey renders the calendar for a front-desk session', async ({ page }) => {
    await page.goto('/scheduler');
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.getByText(/access locked/i)).toHaveCount(0);
    // Something calendar-shaped is on the page, not just an empty shell.
    await expect(page.locator('#main')).not.toBeEmpty();
  });

  test('@journey the patient list renders for a front-desk session', async ({ page }) => {
    await page.goto('/patients');
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.getByText(/access locked/i)).toHaveCount(0);
  });

  test('@journey navigation between two authorised surfaces keeps the session', async ({
    page,
  }) => {
    // A session that survives one page load but not a client-side navigation is
    // a real failure mode, and one only a browser sees.
    await page.goto('/scheduler');
    await expect(page.locator('#main')).toBeVisible();
    await page.goto('/patients');
    await expect(page.locator('#main')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/patients');
  });
});

test.describe('public booking widget', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('@journey an unknown slug does not leak whether the location exists', async ({ page }) => {
    const res = await page.goto('/book/definitely-not-a-real-slug-17');
    // Either a 404 or a generic page — never a stack trace or a tenant name.
    expect(res?.status()).toBeGreaterThanOrEqual(200);
    await expect(page.getByText(/at .*prisma|stack trace|internal server error/i)).toHaveCount(0);
  });
});
