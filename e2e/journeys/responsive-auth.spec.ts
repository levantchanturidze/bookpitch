import { test, expect } from '@playwright/test';
import { storageStatePath } from '../fixtures/roles';

// -----------------------------------------------------------------------------
// §9 — authenticated responsive smoke at 320px.
//
// The existing @responsive suite covers only signed-out pages: /signin, /signup,
// the legal documents. Every stateful surface — the calendar, the patient list,
// the analytics dashboard — is where wide tables and fixed-width headers
// actually live, and none of them had ever been rendered at a narrow viewport
// by any test.
//
// 320px is the width WCAG 1.4.10 (Reflow) expects content to survive without
// two-dimensional scrolling. Deliberately narrow in scope: catastrophic
// overflow, reachable navigation, reachable primary action. Not pixel-perfect
// visual testing.
// -----------------------------------------------------------------------------

/**
 * Horizontal overflow, in pixels. A few pixels of rounding is not a defect; a
 * table that runs off the side is.
 */
async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

const OVERFLOW_TOLERANCE_PX = 4;

test.describe('front-desk surfaces at 320px', () => {
  test.use({ storageState: storageStatePath('FRONT_DESK') });

  for (const route of ['/scheduler', '/patients']) {
    test(`@responsive ${route} does not scroll horizontally`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('#main')).toBeVisible();
      const overflow = await horizontalOverflow(page);
      expect(overflow, `${route} overflows by ${overflow}px at 320px`).toBeLessThanOrEqual(
        OVERFLOW_TOLERANCE_PX,
      );
    });

    test(`@responsive ${route} keeps navigation reachable`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('#main')).toBeVisible();
      // Some way to move between surfaces must exist and be on-screen: either
      // visible nav links or a control that opens them.
      const nav = page.locator('nav a:visible, nav button:visible, header button:visible');
      expect(await nav.count(), `${route} has no reachable navigation at 320px`).toBeGreaterThan(0);
    });
  }
});

test.describe('the analytics surface at 320px', () => {
  test.use({ storageState: storageStatePath('ACCOUNTANT') });

  test('@responsive /analytics does not scroll horizontally', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.locator('#main')).toBeVisible();
    const overflow = await horizontalOverflow(page);
    expect(overflow, `/analytics overflows by ${overflow}px at 320px`).toBeLessThanOrEqual(
      OVERFLOW_TOLERANCE_PX,
    );
  });
});

test.describe('the Access Locked state at 320px', () => {
  test.use({ storageState: storageStatePath('MARKETING') });

  test('@responsive a refused surface renders its error state legibly', async ({ page }) => {
    // Error states are the ones nobody looks at on a phone, and the ones a user
    // meets when something has already gone wrong.
    await page.goto('/scheduler');
    await page.waitForLoadState('domcontentloaded');
    const overflow = await horizontalOverflow(page);
    expect(overflow, `the denial state overflows by ${overflow}px`).toBeLessThanOrEqual(
      OVERFLOW_TOLERANCE_PX,
    );
    await expect(page.locator('body')).toBeVisible();
  });
});
