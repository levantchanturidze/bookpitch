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
import { adminDbUrl } from './admin-db-url';

/** Runs `fn` against a private session pinned to `zone`. */
export async function withTimeZone<T>(
  zone: string,
  fn: (q: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminDbUrl() });
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
