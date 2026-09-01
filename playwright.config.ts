import { defineConfig, devices } from '@playwright/test';
import { ORG_ROLE_ACCOUNTS, PLATFORM_ROLE_ACCOUNTS } from './e2e/fixtures/roles';
import { rateLimitHmacKey, emailPrivacyHmacKey } from './e2e/fixtures/test-env';

// -----------------------------------------------------------------------------
// Playwright suites: public accessibility/responsive, plus authenticated
// journeys.
//
// P17-011 — why this is projects and not `--grep`.
//
// Phase 14 built 141 checks and CI ran them as
// `npx playwright test --grep "@a11y|@responsive"`. A positive grep filter is a
// silent allowlist: e2e/signup-scheduler.spec.ts carried no tag, so it was
// excluded, and nothing anywhere reported that a critical journey had stopped
// running. It sat unexecuted long enough to also go stale — it asserted a
// redirect to /signin after signup, but signup has redirected to
// /onboard/pending since email verification landed, so it would have failed if
// it had ever run.
//
// The failure mode is the shape this repository keeps finding: a signal that
// looks healthy and means nothing. Every project below declares its own
// testMatch, so a spec is either claimed by a project or it runs nowhere — and
// `npm run e2e:check` fails the build if any required project reported zero
// tests. Tags remain in the titles for humans; they no longer decide what runs.
//
// Projects:
//   public-{chromium,firefox,webkit}      three engines, desktop viewport
//   public-{mobile-safari,mobile-chrome}  iPhone- and Pixel-class viewports
//   public-mobile-320                     WCAG 1.4.10 reflow width
//   setup                                 signs in once per role
//   authenticated                         signed-in journeys, desktop Chrome
//   authenticated-mobile-320              signed-in journeys at 320px
//
// Runs against E2E_BASE_URL if set (a preview deploy), otherwise `next start`
// locally on 3210.
// -----------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3210';
const IS_CI = !!process.env.CI;

/** Unauthenticated surfaces — sign-in, signup, legal, 404. */
const PUBLIC_SPECS = ['accessibility.spec.ts', 'component-a11y.spec.ts'];

/** Signed-in journeys. Every file under e2e/journeys/ is claimed here. */
const JOURNEY_SPECS = 'journeys/**/*.spec.ts';

/** The narrow-viewport authenticated smoke, run only at 320px. */
const RESPONSIVE_AUTH_SPEC = 'journeys/responsive-auth.spec.ts';

const DESKTOP_ENGINES = [
  { name: 'public-chromium', device: devices['Desktop Chrome'] },
  { name: 'public-firefox', device: devices['Desktop Firefox'] },
  { name: 'public-webkit', device: devices['Desktop Safari'] },
  { name: 'public-mobile-safari', device: devices['iPhone 13'] },
  { name: 'public-mobile-chrome', device: devices['Pixel 7'] },
] as const;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // A flaky retry hides a real defect; fail honestly and fix the test instead.
  retries: 0,
  forbidOnly: IS_CI,
  // The JSON report is what scripts/check-e2e-coverage.mjs reads to prove each
  // required project actually executed something.
  reporter: IS_CI
    ? [['github'], ['line'], ['json', { outputFile: 'playwright-report/results.json' }]]
    : [['line'], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: {
    baseURL: BASE_URL,
    trace: IS_CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    ...DESKTOP_ENGINES.map((e) => ({
      name: e.name,
      testMatch: PUBLIC_SPECS,
      use: { ...e.device },
    })),
    {
      // 320 px is the narrowest width WCAG 1.4.10 (Reflow) expects content to
      // survive without two-dimensional scrolling. It is also where clipped
      // tables and overflowing headers show up first.
      name: 'public-mobile-320',
      testMatch: PUBLIC_SPECS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 } },
    },
    {
      // Signs in as each role and saves storage state. Everything authenticated
      // depends on this, so a broken sign-in fails here with one clear message
      // instead of failing every journey obscurely.
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authenticated',
      testMatch: JOURNEY_SPECS,
      testIgnore: RESPONSIVE_AUTH_SPEC,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // §9: limited authenticated responsive coverage on stateful pages, at the
      // width where horizontal overflow actually appears.
      name: 'authenticated-mobile-320',
      testMatch: RESPONSIVE_AUTH_SPEC,
      dependencies: ['setup'],
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
        // The authenticated suite needs the app to serve on loopback for the
        // E2E Turnstile credential to be honoured at all — see
        // lib/auth/e2e-turnstile-bypass.ts.
        env: {
          APP_URL: BASE_URL,
          // Without this the guard layer runs in SHADOW mode: requirePermission
          // logs `rbac.shadow_deny` and lets the request through, so every
          // forbidden-URL journey passes through to a rendered page and the
          // denial tests measure nothing. Production sets this to '*'; the
          // suite must test the production configuration, not a laxer one.
          // Measured: with it unset, MARKETING reached /scheduler and /audit
          // and ORG_OWNER reached /platform/orgs.
          RBAC_ENFORCE_MODULES: process.env.RBAC_ENFORCE_MODULES ?? '*',
          // `next start` sets NODE_ENV=production, and two helpers refuse to
          // fall back to a development key there — lib/crypto.ts
          // (EMAIL_PRIVACY_HMAC_KEY) and lib/platform/rate-limit.ts
          // (RATE_LIMIT_HMAC_KEY). Without them signup answers 500 before it
          // reaches any of the logic under test, which is exactly what the
          // first run of the revived journey hit.
          //
          // From e2e/fixtures/test-env.ts so the server and the fixtures that
          // read what it wrote cannot disagree — EMAIL_PRIVACY_HMAC_KEY keys the
          // address hash on every email_outbox row.
          RATE_LIMIT_HMAC_KEY: rateLimitHmacKey(),
          EMAIL_PRIVACY_HMAC_KEY: emailPrivacyHmacKey(),
        },
      },
});

// Referenced so a role added to e2e/fixtures/roles.ts without a matching
// account keeps this config honest at type level rather than at 3am.
void ORG_ROLE_ACCOUNTS;
void PLATFORM_ROLE_ACCOUNTS;
