// -----------------------------------------------------------------------------
// P17-005 — bounded fan-out for per-organization cron work.
//
// `/api/cron/reminders` and `/api/cron/retention` both did:
//
//     const orgs = await withoutRls((tx) => tx.organization.findMany(...));
//     const reports = await Promise.all(orgs.map((o) => runTick(o.id)));
//
// with no take limit on the query and no bound on the map. Every organization
// started at once. With ten organizations that is invisible; with a thousand it
// is a thousand concurrent workloads against a connection pool that lib/db.ts
// caps at PG_POOL_MAX — default 3, and unset in production. The rest queue on
// pool acquisition until they time out, and because `Promise.all` rejects on
// the first failure, one organization's error discards the results of every
// organization that had already succeeded.
//
// Raising PG_POOL_MAX would not fix this. It would move the ceiling from the
// application pool to Supabase's pooler, where the failure is shared with every
// other connection the project has.
//
// This runs `limit` at a time and settles rather than races: a failing
// organization is reported as failed and the others still finish.
// -----------------------------------------------------------------------------

/**
 * Default per-organization concurrency for cron fan-out.
 *
 * Each organization's work holds at most one pooled connection at a time in
 * each of the two pools (unsafePrismaAdmin for the tenant reads/writes,
 * prismaApp for the rate-limit upsert), so concurrency must stay at or below
 * the smaller pool. Defaults to 2 against a default PG_POOL_MAX of 3, leaving
 * a connection free for whatever else the invocation needs.
 *
 * Override with CRON_ORG_CONCURRENCY, but it is clamped to PG_POOL_MAX — a
 * concurrency above the pool size cannot produce more parallelism, only more
 * time spent waiting on pool acquisition.
 */
export function cronOrgConcurrency(): number {
  const poolMax = Math.max(1, Number(process.env.PG_POOL_MAX ?? 3));
  const requested = Math.max(1, Number(process.env.CRON_ORG_CONCURRENCY ?? 2));
  return Math.min(requested, poolMax);
}

export type Settled<R> = { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: string };

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the result. Never rejects: a thrown error becomes a `rejected` entry so
 * one bad item cannot discard the work already done for the others.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  const bound = Math.max(1, Math.floor(limit));
  const results: Array<Settled<R>> = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (err) {
        results[index] = {
          status: 'rejected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(bound, items.length) }, worker));
  return results;
}
