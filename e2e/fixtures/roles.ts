// -----------------------------------------------------------------------------
// P17-010 — the identities the authenticated E2E suite signs in as.
//
// Shared by scripts/seed-e2e-users.ts (which creates them) and e2e/auth.setup.ts
// (which signs in as each one), so the two can never disagree about who exists.
//
// Every account is test-only, lives on a `@e2e.bookpitch.test` address that no
// real mailbox can receive, and is created by the seeding script rather than
// committed anywhere. Passwords come from the environment; nothing here holds
// a credential.
// -----------------------------------------------------------------------------

/** Org-plane roles the browser suite signs in as, and their landing. */
export const ORG_ROLE_ACCOUNTS = {
  ORG_OWNER: 'e2e-owner@e2e.bookpitch.test',
  ORG_ADMIN: 'e2e-admin@e2e.bookpitch.test',
  BRANCH_MANAGER: 'e2e-branchmgr@e2e.bookpitch.test',
  SENIOR_PROVIDER: 'e2e-senior@e2e.bookpitch.test',
  FRONT_DESK: 'e2e-frontdesk@e2e.bookpitch.test',
  PROVIDER: 'e2e-provider@e2e.bookpitch.test',
  ACCOUNTANT: 'e2e-accountant@e2e.bookpitch.test',
  MARKETING: 'e2e-marketing@e2e.bookpitch.test',
} as const;

/**
 * Platform-plane account. PLATFORM_ADMIN rather than SUPER_ADMIN on purpose:
 * the seeded super-admin has MFA enabled, so signing in as it needs a live TOTP
 * code. PLATFORM_ADMIN exercises the same /platform landing and the same
 * `platform.analytics.read` guard without weakening anyone's second factor.
 */
export const PLATFORM_ROLE_ACCOUNTS = {
  PLATFORM_ADMIN: 'e2e-platform@e2e.bookpitch.test',
} as const;

export const ALL_E2E_ACCOUNTS = {
  ...ORG_ROLE_ACCOUNTS,
  ...PLATFORM_ROLE_ACCOUNTS,
} as const;

export type E2ERole = keyof typeof ALL_E2E_ACCOUNTS;

/** Marker on every seeded E2E address, so cleanup can identify them exactly. */
export const E2E_EMAIL_DOMAIN = '@e2e.bookpitch.test';

/**
 * The password for every E2E account. Read from the environment, never
 * defaulted — a committed default is a credential in source, and one that
 * silently works is worse than one that fails loudly.
 */
export function e2ePassword(): string {
  const pw = process.env.E2E_PASSWORD ?? process.env.DEV_USER_PASSWORD;
  if (!pw) {
    throw new Error(
      'E2E_PASSWORD (or DEV_USER_PASSWORD) must be set to seed or sign in as the E2E accounts.',
    );
  }
  if (pw.length < 8) throw new Error('E2E password must be at least 8 characters.');
  return pw;
}

/** Where auth.setup.ts writes each role's saved session. */
export function storageStatePath(role: E2ERole): string {
  return `playwright/.auth/${role.toLowerCase()}.json`;
}
