import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ALL_E2E_ACCOUNTS, e2ePassword, storageStatePath, type E2ERole } from './fixtures/roles';

// -----------------------------------------------------------------------------
// P17-010 — authenticated fixtures.
//
// Signs in once per role through the REAL sign-in form and saves the resulting
// session, so the journey specs start already authenticated without each one
// paying for a login. The brief asks to exercise the real authentication
// mechanism where practical, and it is practical here: /signin has no CAPTCHA,
// so there is no reason to mint a session cookie by hand and no reason for the
// tests to know how the JWT is signed.
//
// What that buys, beyond speed: this file is itself a test of sign-in. If the
// credentials provider, the Auth.js adapter, the session callback or the
// role→landing dispatch breaks, every authenticated project fails at setup with
// a clear message rather than nine specs failing obscurely later.
//
// Accounts come from scripts/seed-e2e-users.ts; the password comes from the
// environment. Nothing here holds a credential.
// -----------------------------------------------------------------------------

const password = e2ePassword();

// Playwright writes storage state relative to the config directory.
mkdirSync(path.join(process.cwd(), 'playwright', '.auth'), { recursive: true });

for (const [role, email] of Object.entries(ALL_E2E_ACCOUNTS) as Array<[E2ERole, string]>) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    await page.goto('/signin');

    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();

    // The root page dispatches by role, so "we are signed in" is "we are no
    // longer on /signin". Asserting the specific destination is the job of
    // journeys/role-landing.spec.ts — doing it here too would make a landing
    // regression look like an authentication failure.
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 });

    // Fail loudly rather than saving an unauthenticated state that makes every
    // downstream spec fail somewhere else. Matches the <main> landmark rather
    // than '#main': the org shell (components/shell/Shell.tsx) gives it an id,
    // the platform shell (components/platform/PlatformShell.tsx) does not, and
    // this file has to work for both planes.
    await expect(page.locator('main').first()).toBeVisible({ timeout: 15_000 });

    await page.context().storageState({ path: storageStatePath(role) });
  });
}
