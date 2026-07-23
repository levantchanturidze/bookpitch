import { test, expect } from '@playwright/test';

// Full-stack smoke: land on /signup, create a workspace, get redirected to
// /signin with the email prefilled path, sign in, and confirm the scheduler
// renders. If this passes we know:
//   - Migrations applied.
//   - Auth.js Prisma adapter loaded.
//   - Onboarding API works end-to-end (POST /api/onboard → 201).
//   - Session cookie set + shell renders under the new org.
test('signup → sign in → scheduler renders', async ({ page }) => {
  const email = `e2e+${Date.now()}@example.dev`;
  const password = 'e2etestpass1';

  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: /create your bookpitch/i })).toBeVisible();

  await page.getByLabel(/your full name/i).fill('E2E Owner');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByLabel(/organisation name/i).fill('E2E Workspace');
  await page.getByRole('button', { name: /create workspace/i }).click();

  // Redirects to /signin?email=…
  await page.waitForURL(/\/signin/);

  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Land on the scheduler — the default landing page in the shell.
  await page.waitForURL(/\/scheduler/);
  await expect(page.locator('#main')).toBeVisible();
});
