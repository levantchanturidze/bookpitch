import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// SEC-007: allowlist for files that may import unsafePrismaAdmin or
// withoutRls from '@/lib/db'. Every entry has a documented reason
// (login/no-session-yet, platform-plane, system-cron/webhook, or RBAC
// context-build). New entries require a code-review call: does this
// caller genuinely need to bypass RLS, or would `withOrg` work? If in
// doubt, the answer is `withOrg`. See docs/rbac-security-review.md
// § SEC-007.
const UNSAFE_DB_ALLOWLIST = [
  // Group A — login / no-session-yet paths (org context does not exist)
  'auth.ts',
  'lib/auth/credentials.ts',
  'lib/auth/password-reset.ts',
  'app/api/auth/reset/request/route.ts',
  'lib/onboarding.ts',
  'lib/invitations.ts',
  'lib/org-switch.ts',
  'lib/rbac/context.ts',
  'lib/public-booking.ts',

  // Group B — platform-plane by design (SUPER/PLATFORM roles, cross-tenant)
  'app/platform/audit/page.tsx',
  'app/platform/break-glass/page.tsx',
  'app/api/platform/audit/route.ts',
  'app/api/platform/orgs/*/toggles/route.ts',
  'lib/platform/orgs.ts',
  'lib/platform/roles.ts',
  'lib/platform/impersonation.ts',
  'lib/platform/break-glass.ts',
  'lib/platform/audit.ts',
  'lib/platform/password-reauth.ts',
  // F1/F2 additions: distributed reauth grant + TOTP MFA (SEC-007 Group B)
  'lib/platform/rate-limit.ts',
  'lib/platform/mfa.ts',

  // Group C — system cron / webhook / probe (no session)
  'app/api/cron/db-partitions/route.ts',
  'app/api/cron/reminders/route.ts',
  'app/api/cron/retention/route.ts',
  'app/api/health/route.ts',
  // Phase 13 production monitor probe: cross-tenant COUNTs only, no session.
  'lib/ops-metrics.ts',
  'lib/audit-digest.ts',
  'lib/housekeeping.ts',
  'lib/messaging/reminders.ts',
  'lib/billing/service.ts',
  'lib/payments/service.ts',

  // Group D — RBAC/ownership infrastructure crossing tenants
  'lib/rbac/rank.ts',
  'lib/rbac/toggles.ts',
  'lib/admin/ownership-transfer.ts',
  'lib/push.ts',
  'lib/gdpr.ts',

  // The clients themselves + tests/seeds/scripts are also exempt.
  'lib/db.ts',
  'prisma/**',
  'scripts/**',
  'tests/**',
];

const RESTRICT_UNSAFE_DB = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: '@/lib/db',
          // `prismaLogin` is on this list too — even though it has narrow SELECT
          // grants when DATABASE_URL_LOGIN is set, it can transparently fall
          // back to unsafePrismaAdmin. Restrict its import to the same
          // reviewable surface. Only lib/rbac/context.ts (buildAuthContext) is
          // meant to use it; new callers should surface for review.
          importNames: ['unsafePrismaAdmin', 'withoutRls', 'prismaLogin'],
          message:
            'SEC-007: these bypass RLS. Use `withOrg(orgId, tx => …)` instead. ' +
            'If a cross-tenant reach is genuinely required (login path, platform ' +
            'plane, cron), add this file to UNSAFE_DB_ALLOWLIST in eslint.config.mjs ' +
            'with a comment explaining which group (A/B/C/D) it belongs to. See ' +
            'docs/rbac-security-review.md § SEC-007.',
        },
      ],
    },
  ],
};

// TZ-001: ban Date methods that use process-local timezone instead of
// the org's IANA timezone. All display paths must go through lib/tz.ts.
// lib/tz.ts itself uses Intl.DateTimeFormat and is the sole exemption.
const RESTRICT_TZ_DISPLAY = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='getHours']",
      message:
        "TZ-001: .getHours() reads process-local time. Use toLocalTimeHHMM(utc, tz) from '@/lib/tz'.",
    },
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='getMinutes']",
      message:
        "TZ-001: .getMinutes() reads process-local time. Use toLocalTimeHHMM(utc, tz) from '@/lib/tz'.",
    },
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='getDay']",
      message:
        "TZ-001: .getDay() reads process-local weekday. Use localDateWeekday(dateStr, tz) from '@/lib/tz'.",
    },
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.name='toLocaleDateString']",
      message:
        "TZ-001: .toLocaleDateString() ignores org timezone. Use toLocalDate(utc, tz) from '@/lib/tz'.",
    },
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.name='toLocaleTimeString']",
      message:
        "TZ-001: .toLocaleTimeString() ignores org timezone. Use toLocalTimeHHMM(utc, tz) from '@/lib/tz'.",
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Reference-only prototype (not part of the Next.js app):
    'prototype/**',
  ]),
  // Ported prototype code lives here verbatim until P1.3 wires it in.
  // Downgrade rules that only fire because of that not-yet-refactored code.
  {
    files: ['components/**/*.{ts,tsx}', 'lib/types.ts'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react/no-unescaped-entities': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@next/next/no-img-element': 'warn',
    },
  },
  // SEC-007: default rule for every runtime source file — block
  // unsafePrismaAdmin / withoutRls imports.
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'auth.ts'],
    rules: RESTRICT_UNSAFE_DB,
  },
  // Allowlist: turn the rule OFF for files that legitimately need
  // cross-tenant reach. Each entry is auditable in git blame.
  {
    files: UNSAFE_DB_ALLOWLIST,
    rules: { 'no-restricted-imports': 'off' },
  },
  // TZ-001: enforce timezone-aware formatting in all source files.
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: RESTRICT_TZ_DISPLAY,
  },
  // lib/tz.ts is the conversion boundary — it uses Intl.DateTimeFormat
  // internally and is exempt. tests/** may use native Date methods for fixtures.
  {
    files: ['lib/tz.ts', 'tests/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // LOG-001: ban raw console.* in server-side code. All logging must go through
  // lib/logger.ts (log.info / log.warn / log.error) so scrubSensitive redacts
  // PII before emission. lib/logger.ts is the sole allowlisted caller.
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
]);

export default eslintConfig;
