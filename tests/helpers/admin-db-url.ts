// -----------------------------------------------------------------------------
// The connection string for a test's own private, RLS-exempt session.
//
// A few tests need a second connection that Prisma is not managing: a session
// whose TimeZone they control (tests/helpers/tz-session.ts) or one that probes
// a row lock while the code under test runs (tests/phase17-reminder-boundary).
//
// Both used to read `ADMIN_DATABASE_URL` and nothing else. That variable is set
// in a developer's .env.local and is NOT set on a GitHub Actions runner, where
// the superuser URL is `DATABASE_URL_SUPERUSER_SESSION` — so both files failed
// the first time this repository's CI actually ran them (run 33491923279):
// tz-session threw "ADMIN_DATABASE_URL is not set and .env.local does not
// exist", and the lock probe connected with `undefined`, fell back to libpq's
// unix-socket defaults, threw inside the provider hook, and turned three
// boundary assertions into `expected 'failed' to be 'sent'`.
//
// Resolution order mirrors lib/db.ts::adminUrl so a test and the application
// cannot disagree about which role is the privileged one.
//
// It must resolve to a role that is NOT subject to row-level security: the lock
// probe takes `FOR UPDATE NOWAIT` on `appointments`, and 20 tables carry FORCE
// RLS, so a NOBYPASSRLS role would see zero rows, take no lock, and report
// "lockable" every time — a probe that always passes.
// -----------------------------------------------------------------------------

/**
 * @returns a libpq-compatible connection string with any query string removed.
 *   `?pgbouncer=true`, which Prisma accepts and `pg` rejects with
 *   "invalid URI query parameter", is the reason for the strip.
 */
export function adminDbUrl(): string {
  const url =
    process.env.DATABASE_URL_SUPERUSER_SESSION ??
    process.env.ADMIN_DATABASE_URL ??
    process.env.DATABASE_URL_SUPERUSER_DIRECT;

  if (!url) {
    throw new Error(
      'No privileged database URL for this test. Set DATABASE_URL_SUPERUSER_SESSION ' +
        '(CI) or ADMIN_DATABASE_URL (.env.local). DATABASE_URL is deliberately not a ' +
        'fallback: it points at the NOBYPASSRLS application role, which would make the ' +
        'row-lock probe silently useless.',
    );
  }
  return url.replace(/\?.*$/, '');
}
