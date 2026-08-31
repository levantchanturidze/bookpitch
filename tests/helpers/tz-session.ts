// -----------------------------------------------------------------------------
// A PostgreSQL session whose TimeZone this test controls.
//
// `SET TIME ZONE` is per-connection. Prisma hands each query whichever pooled
// connection is free, so a SET issued through Prisma may apply to a connection
// the next query never touches — the setting appears to work, then silently
// does not. Timezone assertions need their own connection, held open for the
// duration of the check.
// -----------------------------------------------------------------------------

import { Client } from 'pg';
import { existsSync, readFileSync } from 'node:fs';

function connectionString(): string {
  if (process.env.ADMIN_DATABASE_URL) {
    return process.env.ADMIN_DATABASE_URL.replace(/\?.*$/, '');
  }
  if (!existsSync('.env.local')) {
    throw new Error('ADMIN_DATABASE_URL is not set and .env.local does not exist');
  }
  const txt = readFileSync('.env.local', 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === 'ADMIN_DATABASE_URL') {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v.replace(/\?.*$/, '');
    }
  }
  throw new Error('ADMIN_DATABASE_URL not found in .env.local');
}

/** Runs `fn` against a private session pinned to `zone`. */
export async function withTimeZone<T>(
  zone: string,
  fn: (q: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await client.query(`SET TIME ZONE '${zone}'`);
    const [{ tz }] = (
      await client.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")
    ).rows;
    if (tz !== zone) throw new Error(`session did not adopt ${zone} (got ${tz})`);
    return await fn(async <R>(sql: string, params: unknown[] = []) => {
      const res = await client.query(sql, params);
      return res.rows as R[];
    });
  } finally {
    await client.end();
  }
}
