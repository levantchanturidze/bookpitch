import { defineConfig, devices } from '@playwright/test';

// -----------------------------------------------------------------------------
// Playwright E2E + accessibility + responsive suite.
//
// Phase 14 widened this from a single Chromium smoke path. The old comment said
// "one full-stack path is enough to catch a broken deploy" — true for deploys,
// but it meant the product had zero coverage on Firefox or WebKit, and zero at
// any viewport other than a desktop Chrome window. Every mobile and Safari
// defect was, by construction, invisible.
//
// Projects:
//   chromium / firefox / webkit  — the three engines, desktop viewport
//   mobile-safari / mobile-chrome— iPhone- and Pixel-class viewports
//   mobile-320                   — the narrow end of the real world, where
//                                  horizontal overflow actually shows up
//
// Runs against E2E_BASE_URL if set (a preview deploy), otherwise `next start`
// locally on 3210. Grep tags let CI split fast checks from full-stack ones:
//   npx playwright test --grep @a11y
//   npx playwright test --project=webkit
// -----------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3210';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // A flaky retry hides a real defect; fail honestly and fix the test instead.
  retries: 0,
  forbidOnly: IS_CI,
  reporter: IS_CI ? [['github'], ['line']] : 'line',
  use: {
    baseURL: BASE_URL,
    trace: IS_CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    {
      // 320 px is the narrowest width WCAG 1.4.10 (Reflow) expects content to
      // survive without two-dimensional scrolling. It is also where clipped
      // tables and overflowing headers show up first.
      name: 'mobile-320',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 } },
    },
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
