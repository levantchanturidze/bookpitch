import { defineConfig, devices } from '@playwright/test';

// -----------------------------------------------------------------------------
// Playwright E2E smoke suite. Kept small on purpose — one full-stack path
// (signup → land on scheduler) is enough to catch a broken deploy without
// blocking CI on flaky wait-for-selector cascades.
//
// Runs against E2E_BASE_URL if set (a preview deploy on Vercel), otherwise
// spins up `next start` locally on port 3210. Assumes the DB is reachable
// and migrations are applied — matches the vitest setup expectation.
// -----------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3210';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: IS_CI ? [['github'], ['line']] : 'line',
  use: {
    baseURL: BASE_URL,
    trace: IS_CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npx next start -p 3210',
        url: 'http://localhost:3210/signin',
        reuseExistingServer: !IS_CI,
        timeout: 120_000,
      },
});
