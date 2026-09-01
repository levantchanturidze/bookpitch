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

const OVERFLOW_TOLERANCE_PX = 4;

/**
 * Horizontal overflow, in pixels. A few pixels of rounding is not a defect; a
 * table that runs off the side is.
 */
async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * What is actually sticking out, so a failure names the element instead of a
 * number.
 *
 * "overflows by 143px" was the entire failure message the first time this
 * project ran on a Linux runner (CI run 33491923279), while the same page
 * measured 0 on the developer's machine. A pixel count that reproduces nowhere
 * is not a diagnosis, and every minute spent guessing at it is a minute the
 * test could have spent explaining itself.
 */
async function overflowReport(page: import('@playwright/test').Page): Promise<string> {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const rows: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const right = Math.round(r.right + window.scrollX);
      if (right <= limit + 1) continue;
      const cls = (el.getAttribute('class') ?? '').slice(0, 90);
      rows.push(
        `right=${right} w=${Math.round(r.width)} <${el.tagName.toLowerCase()}` +
          `${el.id ? `#${el.id}` : ''} class="${cls}">`,
      );
    }
    return {
      clientWidth: limit,
      scrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: rows.slice(0, 8),
    };
  });
  return (
    `clientWidth=${report.clientWidth} scrollWidth=${report.scrollWidth} ` +
    `bodyScrollWidth=${report.bodyScrollWidth}\n` +
    (report.offenders.length
      ? `widest elements past the viewport:\n  ${report.offenders.join('\n  ')}`
      : 'no element extends past the viewport — the overflow is on a scrolling ancestor')
  );
}

/** Assert no catastrophic horizontal overflow, and say what caused it if there is. */
async function expectNoHorizontalOverflow(page: import('@playwright/test').Page, label: string) {
  const overflow = await horizontalOverflow(page);
  if (overflow <= OVERFLOW_TOLERANCE_PX) return;
  expect(
    overflow,
    `${label} overflows by ${overflow}px at 320px\n${await overflowReport(page)}`,
  ).toBeLessThanOrEqual(OVERFLOW_TOLERANCE_PX);
}

test.describe('front-desk surfaces at 320px', () => {
  test.use({ storageState: storageStatePath('FRONT_DESK') });

  for (const route of ['/scheduler', '/patients']) {
    test(`@responsive ${route} does not scroll horizontally`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('#main')).toBeVisible();
      await expectNoHorizontalOverflow(page, route);
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
    await expectNoHorizontalOverflow(page, '/analytics');
  });
});

test.describe('the Access Locked state at 320px', () => {
  test.use({ storageState: storageStatePath('MARKETING') });

  test('@responsive a refused surface renders its error state legibly', async ({ page }) => {
    // Error states are the ones nobody looks at on a phone, and the ones a user
    // meets when something has already gone wrong.
    await page.goto('/scheduler');
    await page.waitForLoadState('domcontentloaded');
    await expectNoHorizontalOverflow(page, 'the denial state');
    await expect(page.locator('body')).toBeVisible();
  });
});
