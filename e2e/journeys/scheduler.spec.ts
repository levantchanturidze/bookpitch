import { test, expect } from '@playwright/test';
import { storageStatePath } from '../fixtures/roles';

test.describe('scheduler', () => {
  test.use({ storageState: storageStatePath('FRONT_DESK') });

  test('@journey renders the calendar for a front-desk session', async ({ page }) => {
    await page.goto('/scheduler');
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.getByText(/access locked/i)).toHaveCount(0);
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
    await page.goto('/scheduler');
    await expect(page.locator('#main')).toBeVisible();
    await page.goto('/patients');
    await expect(page.locator('#main')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/patients');
  });
});

test.describe('scheduler reschedule workflow', () => {
  test.use({ storageState: storageStatePath('ORG_OWNER') });

  test('@journey keeps its own slot visible and moves through the canonical update path', async ({
    page,
  }) => {
    await page.goto('/scheduler?month=2026-07');

    const panel = page.getByRole('region', {
      name: 'Reschedule Appointment',
    });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('Appointment').locator('option')).not.toHaveCount(0);

    const currentTime = (await panel.getByTestId('reschedule-current-time').textContent())?.trim();
    expect(currentTime).toBeTruthy();

    const timeSelect = panel.getByLabel('Available time');
    await expect(timeSelect).toBeEnabled();
    await expect(timeSelect.locator(`option[value="${currentTime}"]`)).toHaveCount(1);

    const values = await timeSelect
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const alternate = values.find((value) => value !== currentTime);
    expect(alternate).toBeTruthy();

    await timeSelect.selectOption(alternate!);
    await panel.getByRole('button', { name: 'Save new time' }).click();
    await expect(panel.getByText('Appointment rescheduled successfully.')).toBeVisible();
  });
});

test.describe('public booking widget', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('@journey an unknown slug does not leak whether the location exists', async ({ page }) => {
    const res = await page.goto('/book/definitely-not-a-real-slug-17');
    expect(res?.status()).toBeGreaterThanOrEqual(200);
    await expect(page.getByText(/at .*prisma|stack trace|internal server error/i)).toHaveCount(0);
  });
});
