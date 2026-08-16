// -----------------------------------------------------------------------------
// RBAC Phase 4 — CI guard scanner.
//
//   npm run test:guards
//
// Walks every `app/api/**/route.ts` and `app/(app)/**/{page,layout}.tsx` and
// verifies each file contains a `requireAuthContext(` or `requirePermission(`
// or `requireSession(` call. Files in NO_GUARD_ALLOWLIST are exempt with a
// documented reason.
//
// Exit non-zero (fails CI) on any un-guarded file that isn't in the allowlist.
// Adding a new path means updating the allowlist deliberately — the audit
// trail is in git.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

// -----------------------------------------------------------------------------
// The allowlist. Each entry is a repo-relative path with an alternate auth
// mechanism documented alongside. See docs/rbac-enforcement-audit.md §16.
// -----------------------------------------------------------------------------
const NO_GUARD_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  { path: 'app/api/auth/[...nextauth]/route.ts', reason: 'Auth.js internal handler' },
  {
    path: 'app/api/auth/reset/consume/route.ts',
    reason: 'Password reset consume — no session yet, JWT-token auth',
  },
  {
    path: 'app/api/auth/reset/request/route.ts',
    reason: 'Password reset request — no session yet, rate-limited',
  },
  { path: 'app/api/cron/audit-digest/route.ts', reason: 'Scheduled worker — Bearer CRON_SECRET' },
  { path: 'app/api/cron/db-partitions/route.ts', reason: 'Scheduled worker — Bearer CRON_SECRET' },
  { path: 'app/api/cron/housekeeping/route.ts', reason: 'Scheduled worker — Bearer CRON_SECRET' },
  { path: 'app/api/cron/reminders/route.ts', reason: 'Scheduled worker — Bearer CRON_SECRET' },
  { path: 'app/api/cron/retention/route.ts', reason: 'Scheduled worker — Bearer CRON_SECRET' },
  { path: 'app/api/health/route.ts', reason: 'Uptime probe — no tenant data' },
  {
    path: 'app/api/health/ops/route.ts',
    reason: 'Production monitor probe — Bearer CRON_SECRET, numeric counts only',
  },
  {
    path: 'app/api/invitations/accept/route.ts',
    reason: 'Invitation token consume — invitee has no session yet',
  },
  { path: 'app/api/onboard/route.ts', reason: 'Self-signup — no session yet, rate-limited' },
  {
    path: 'app/api/onboard/resend/route.ts',
    reason: 'Resend verification email — no session yet; enumeration-safe, IP + email rate-limited',
  },
  {
    path: 'app/api/onboard/verify/route.ts',
    reason: 'Email verification link — no session; auth is 256-bit token in URL, rate-limited',
  },
  {
    path: 'app/api/public/book/route.ts',
    reason: 'Public booking widget — rate-limited by IP + public slug',
  },
  { path: 'app/api/webhooks/payment/route.ts', reason: 'Payment gateway webhook — HMAC signature' },
  { path: 'app/api/webhooks/stripe/route.ts', reason: 'Stripe webhook — Stripe signature' },
  {
    path: 'app/(app)/settings/page.tsx',
    reason: 'Redirect page — inherits settings/layout.tsx guard',
  },
];

const GUARD_RE = /(requireAuthContext|requirePermission|requireSession)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isTarget(rel: string): boolean {
  if (rel.startsWith('app/api/') && rel.endsWith('/route.ts')) return true;
  if (
    (rel.startsWith('app/(app)/') || rel.startsWith('app/platform/')) &&
    (rel.endsWith('/page.tsx') || rel.endsWith('/layout.tsx'))
  )
    return true;
  return false;
}

function main() {
  const files = [
    ...walk(path.join(ROOT, 'app', 'api')),
    ...walk(path.join(ROOT, 'app', '(app)')),
    ...walk(path.join(ROOT, 'app', 'platform')),
  ].map((f) => path.relative(ROOT, f));

  const targets = files.filter(isTarget);
  const allowed = new Set(NO_GUARD_ALLOWLIST.map((a) => a.path));
  const missing: string[] = [];

  for (const rel of targets) {
    if (allowed.has(rel)) continue;
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    if (!GUARD_RE.test(src)) missing.push(rel);
  }

  // Also warn on stale allowlist entries — files that were removed but the
  // allowlist still names them. Failing on this keeps the allowlist honest.
  const targetSet = new Set(targets);
  const stale = NO_GUARD_ALLOWLIST.filter((a) => !targetSet.has(a.path));

  console.log(`Scanned ${targets.length} entry points; ${allowed.size} allow-listed.`);

  if (missing.length === 0 && stale.length === 0) {
    console.log('All guarded.');
    return 0;
  }

  if (missing.length > 0) {
    console.error(`\n${missing.length} un-guarded entry point(s):`);
    for (const p of missing) console.error(`  ✗ ${p}`);
    console.error(
      '\nEach file must call requireAuthContext() or requirePermission() before touching',
    );
    console.error('tenant data, or be added to NO_GUARD_ALLOWLIST in scripts/check-guards.ts with');
    console.error('a comment explaining the alternate auth mechanism.');
  }

  if (stale.length > 0) {
    console.error(
      `\n${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} (file no longer exists):`,
    );
    for (const s of stale) console.error(`  ✗ ${s.path}`);
    console.error('\nRemove them from scripts/check-guards.ts::NO_GUARD_ALLOWLIST.');
  }

  return 1;
}

process.exit(main());
