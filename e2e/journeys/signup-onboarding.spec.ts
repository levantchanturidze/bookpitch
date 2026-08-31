import { test, expect } from '@playwright/test';
import { findVerificationEmailBody, deleteSignupArtifacts, withDb } from '../fixtures/db';

// -----------------------------------------------------------------------------
// Journey 3 — signup → email verification → a working signed-in workspace.
//
// This replaces e2e/signup-scheduler.spec.ts, which was excluded from every run
// by CI's `--grep "@a11y|@responsive"` filter and had gone stale while nobody
// was looking: it waited for a redirect to /signin after submitting the signup
// form, but signup has redirected to /onboard/pending since email verification
// landed. It would have failed had it ever executed.
//
// Signup is the path that was completely broken in production twice — once when
// two Turnstile variables were unset and every attempt returned 400 (P13), once
// when FIELD_ENCRYPTION_KEY was malformed and every attempt returned 500
// (P15-010). Neither was caught by a test, because no test could get past the
// CAPTCHA in a production-mode build. That is what the E2E Turnstile credential
// exists for — see lib/auth/e2e-turnstile-bypass.ts, and
// tests/phase17-turnstile-bypass.test.ts for why it cannot activate in
// production.
//
// Runs serially: it creates a real organisation and cleans it up afterwards.
// -----------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

// Signed out — signup is a public surface.
test.use({ storageState: { cookies: [], origins: [] } });

const RUN = Date.now();
const EMAIL = `e2e-signup-${RUN}@e2e.bookpitch.test`;
const PASSWORD = 'e2e-signup-pass-9812';
const ORG_NAME = `E2E Workspace ${RUN}`;

test.afterAll(async () => {
  await deleteSignupArtifacts(EMAIL);
});

test('@journey signup creates a pending registration and queues a verification email', async ({
  page,
}) => {
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: /create your bookpitch/i })).toBeVisible();

  await page.getByLabel(/your full name/i).fill('E2E Owner');
  await page.getByLabel(/^email$/i).fill(EMAIL);
  await page.getByLabel(/^password$/i).fill(PASSWORD);
  await page.getByLabel(/organisation name/i).fill(ORG_NAME);

  const submit = page.getByRole('button', { name: /create workspace/i });
  // The button being enabled at all is half the test: in a production-mode
  // build with no Turnstile site key it stays disabled forever, which is
  // exactly why this journey could never run before.
  await expect(submit).toBeEnabled();
  await submit.click();

  await page.waitForURL('**/onboard/pending', { timeout: 20_000 });

  // The account must NOT exist yet — verification is what creates it.
  const pending = await withDb(async (c) => {
    const { rows } = await c.query(
      'SELECT 1 FROM pending_registrations WHERE lower(email)=lower($1)',
      [EMAIL],
    );
    return rows.length;
  });
  expect(pending).toBe(1);

  const users = await withDb(async (c) => {
    const { rows } = await c.query('SELECT 1 FROM app_users WHERE lower(email)=lower($1)', [EMAIL]);
    return rows.length;
  });
  expect(users, 'the org must not exist before the link is clicked').toBe(0);
});

test('@journey the verification link activates the workspace', async () => {
  const body = await findVerificationEmailBody(EMAIL);
  expect(body, 'no verification email was queued for the new signup').toBeTruthy();
  expect(body).toContain('/api/onboard/verify?token=');
});

test('@journey the new owner can sign in and reach the scheduler', async ({ page }) => {
  const body = await findVerificationEmailBody(EMAIL);
  const link = /https?:\/\/[^\s]+\/api\/onboard\/verify\?token=[A-Za-z0-9]+/.exec(body ?? '')?.[0];
  expect(link, 'could not extract the verification link').toBeTruthy();

  // The link is absolute and points at APP_URL; follow only its path+query so
  // the test stays on the base URL Playwright was configured with.
  const url = new URL(link!);
  await page.goto(`${url.pathname}${url.search}`);
  await page.waitForURL('**/onboard/success', { timeout: 20_000 });

  // …and the workspace really works: sign in, land on the scheduler, see a shell.
  await page.goto('/signin');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL('**/scheduler', { timeout: 20_000 });
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.getByText(/access locked/i)).toHaveCount(0);

  // The invariant that matters for a new tenant: exactly one active ORG_OWNER.
  const owners = await withDb(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
         JOIN app_users u ON u.id = m.user_id
        WHERE lower(u.email) = lower($1) AND r.key = 'ORG_OWNER' AND m.status = 'active'`,
      [EMAIL],
    );
    return Number(rows[0].n);
  });
  expect(owners).toBe(1);
});
