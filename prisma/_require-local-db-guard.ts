// -----------------------------------------------------------------------------
// F-02: hard guard imported at the top of every seed/fixture script that
// wipes or mass-creates data. Node hoists imports and evaluates them in
// order, so `import './_require-local-db-guard'` at the very top of a
// seed file runs THIS module's top-level code before any other import
// (including `@/lib/db`, which can itself throw on module load).
//
// Refuses to proceed when any admin/runtime DB URL is set at process start
// and points at a non-local host. `.env.local`'s values are NOT loaded at
// this point — callers who inline a prod URL get an unambiguous refusal
// here; bare-shell invocations that will later pick up a localhost
// `.env.local` proceed silently. Checks BOTH the new SEC-007 names and the
// legacy names so guard fires regardless of which name the operator uses.
//
// Escape hatch: BOOKPITCH_ALLOW_NON_LOCAL_SEED=1 (only for a deliberate
// staging reset — never for CI, never for prod).
// -----------------------------------------------------------------------------
const raw =
  process.env.DATABASE_URL_SUPERUSER_SESSION ??
  process.env.DATABASE_URL_SUPERUSER_TXPOOL ??
  process.env.DATABASE_URL_APP_NOBYPASSRLS ??
  process.env.ADMIN_DATABASE_URL ??
  process.env.ADMIN_RUNTIME_DATABASE_URL ??
  process.env.DATABASE_URL;
if (raw) {
  const isLocal = /(^|@)(localhost|127\.0\.0\.1)(:|\/)/.test(raw);
  if (!isLocal && process.env.BOOKPITCH_ALLOW_NON_LOCAL_SEED !== '1') {
    let host = '<unparseable>';
    try {
      host = new URL(raw).hostname || '<empty>';
    } catch {
      /* leave */
    }
    console.error(`[seed guard] refusing to run against non-local DB (host=${host}).`);
    console.error('The script that imported this guard calls deleteMany and/or seeds test');
    console.error('users with a repo-committed default password. Set');
    console.error('BOOKPITCH_ALLOW_NON_LOCAL_SEED=1 only for a deliberate non-local seed.');
    process.exit(1);
  }
}
