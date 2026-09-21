import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// Runtime proof that a destructive script is pointed at a throwaway database.
//
// `_require-local-db-guard.ts` runs at import time, before `.env.local` is
// loaded, and its own header admits the gap: "bare-shell invocations that will
// later pick up a localhost .env.local proceed silently". That is allow-by-
// default for the most common way the seed is actually run — nothing is set at
// process start, so nothing is checked, and whatever `.env.local` supplies
// afterwards is used unexamined. If that file ever held a production URL the
// seed would wipe production with no refusal anywhere.
//
// So the import-time guard stays (it catches an inlined production URL before
// any module can connect), and this runs AFTER the environment is resolved and
// BEFORE anything destructive happens. It checks the connection the process
// actually holds rather than a string it was given:
//
//   * every URL the process will use must name the SAME host and database —
//     a seed that resets one database and writes another is not something to
//     discover halfway through;
//   * the host must be loopback;
//   * the database name must match the disposable allow-list;
//   * no production marker may appear anywhere in the host;
//   * `current_database()` must agree with the URL, asked over the live
//     connection, because a pooler or a PGDATABASE override can redirect a
//     connection away from what the URL says.
//
// Fails closed: an unparseable, absent, or unrecognised target is refused, not
// assumed safe. Only sanitized identity is ever printed — never a credential.
// -----------------------------------------------------------------------------

/** Database names a destructive script may touch. Anything else is refused. */
const DISPOSABLE_DB_PATTERN =
  /^bookpitch_(dev|test|ci|e2e|cleantest|migtest|stagea|[a-z0-9_]*test)$/;

/** Substrings that mark a managed or shared host. Never destructive targets. */
const PRODUCTION_MARKERS = [
  'supabase',
  'pooler',
  'amazonaws',
  'rds',
  'neon',
  'render',
  'railway',
  'planetscale',
  'azure',
  'gcp',
  'digitalocean',
  'heroku',
  'prod',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

/** Every variable that can carry a target for a destructive script. */
const URL_VARS = [
  'DATABASE_URL',
  'DATABASE_URL_SUPERUSER_MIGRATE',
  'DATABASE_URL_SUPERUSER_SESSION',
  'DATABASE_URL_SUPERUSER_TXPOOL',
  'DATABASE_URL_APP_NOBYPASSRLS',
  'ADMIN_DATABASE_URL',
  'ADMIN_RUNTIME_DATABASE_URL',
  'DIRECT_URL',
] as const;

export type DatabaseIdentity = { host: string; database: string; role: string };

class UnsafeDatabaseTarget extends Error {
  constructor(message: string) {
    super(`[disposable-db guard] ${message}`);
    this.name = 'UnsafeDatabaseTarget';
  }
}

/** Host/database/role of a URL. Never returns or logs the password. */
function identityOf(variable: string, raw: string): DatabaseIdentity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeDatabaseTarget(`${variable} is not a parseable URL — refusing.`);
  }
  return {
    host: url.hostname,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    role: decodeURIComponent(url.username),
  };
}

/**
 * Refuse unless this process is unmistakably pointed at a disposable database.
 *
 * Call it before the first destructive statement, not at import time — the
 * environment is not resolved yet at import time, which is the whole gap.
 */
export async function assertDisposableDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DatabaseIdentity> {
  const present = URL_VARS.filter((name) => (env[name] ?? '').trim()).map(
    (name) => [name, identityOf(name, (env[name] ?? '').trim())] as const,
  );

  if (present.length === 0) {
    throw new UnsafeDatabaseTarget(
      'no database URL is set, so the target cannot be proven disposable. Refusing ' +
        'rather than connecting to whatever a later import happens to resolve.',
    );
  }

  // One target, or none. A script that resets one database and seeds another is
  // a bug you want to hear about before the reset, not after.
  const [firstVar, first] = present[0];
  for (const [name, id] of present) {
    if (id.host !== first.host || id.database !== first.database) {
      throw new UnsafeDatabaseTarget(
        `${name} points at ${id.host}/${id.database} but ${firstVar} points at ` +
          `${first.host}/${first.database}. Refusing to run against two targets.`,
      );
    }
  }

  const host = first.host.toLowerCase();
  const marker = PRODUCTION_MARKERS.find((m) => host.includes(m));
  if (marker) {
    throw new UnsafeDatabaseTarget(
      `host contains the production marker "${marker}" — refusing. This script ` +
        'deletes data and seeds accounts with a repo-committed password.',
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new UnsafeDatabaseTarget(
      `host "${host}" is not loopback. An unrecognised host is refused rather ` +
        'than assumed safe.',
    );
  }
  if (!DISPOSABLE_DB_PATTERN.test(first.database)) {
    throw new UnsafeDatabaseTarget(
      `database "${first.database}" is not in the disposable allow-list ` +
        `(${DISPOSABLE_DB_PATTERN}). Rename the database or point at a throwaway one.`,
    );
  }

  // Ask the LIVE connection. A pooler, a PGDATABASE override, or a service
  // rewriting the DSN can land a connection somewhere the URL never named.
  const [row] = await unsafePrismaAdmin.$queryRawUnsafe<
    Array<{ db: string; usr: string; addr: string | null }>
  >(
    // host() strips the netmask: inet_server_addr()::text yields '::1/128',
    // which no literal loopback comparison would ever match.
    `SELECT current_database() AS db, current_user AS usr, host(inet_server_addr()) AS addr`,
  );

  if (!row) {
    throw new UnsafeDatabaseTarget('the database did not answer an identity query — refusing.');
  }
  if (row.db !== first.database) {
    throw new UnsafeDatabaseTarget(
      `the live connection reports database "${row.db}" but the URL names ` +
        `"${first.database}". Refusing — something is redirecting this connection.`,
    );
  }
  // The server address must not be PUBLICLY ROUTABLE.
  //
  // Not "must be loopback" — that refused CI, where Postgres runs as a service
  // container reached through a Docker bridge: the client connects to
  // localhost and the server answers from 172.18.0.2. That database is as
  // disposable as it gets (created and destroyed per job), so a loopback-only
  // rule rejects the safest target in the system.
  //
  // What this check is actually for is narrower: catching a connection that
  // was REDIRECTED somewhere the URL never named — a pooler, a tunnel, a DSN
  // rewritten by a service. Those land on public addresses. A private or
  // loopback address cannot be a managed provider, so the honest rule is to
  // refuse public ones and accept the rest.
  if (row.addr && isPubliclyRoutable(row.addr)) {
    throw new UnsafeDatabaseTarget(
      `the live connection reports the publicly routable server address "${row.addr}". ` +
        'Something redirected this connection away from the local target.',
    );
  }

  // Sanitized identity only. Host, database and role are not secrets; the
  // password never leaves the URL object.
  const identity: DatabaseIdentity = { host, database: row.db, role: row.usr };
  console.log(
    `[disposable-db guard] verified target: host=${identity.host} db=${identity.database} role=${identity.role}`,
  );
  return identity;
}

/**
 * Is this a globally routable address?
 *
 * Loopback, RFC1918 private space, link-local and IPv6 ULA are all "somewhere
 * on this machine or this container network" — which is what a disposable
 * database looks like, whether it runs on the host or in a CI service
 * container. Everything else is somewhere else, and a destructive script has
 * no business there.
 *
 * Unparseable input returns false: the caller has already proven the URL host
 * and current_database(); refusing on an address string this cannot classify
 * would fail the build on a Postgres that simply reports something unusual.
 */
export function isPubliclyRoutable(addr: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr.trim());
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return false; // loopback
    if (a === 10) return false; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918 — CI containers
    if (a === 192 && b === 168) return false; // RFC1918
    if (a === 169 && b === 254) return false; // link-local
    return true;
  }
  const v6 = addr.trim().toLowerCase();
  if (v6 === '::1' || v6 === 'localhost') return false;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return false; // ULA fc00::/7
  if (/^fe80:/.test(v6)) return false; // link-local
  if (v6.includes(':')) return true; // some other global v6
  return false; // unclassifiable — the URL and current_database() already agreed
}
