# Performance & query tuning

`pg_stat_statements` is enabled from the `index_tuning` migration onward. It's
the primary source of truth for "what is actually slow in production."

## Finding hot queries

```sql
SELECT
    round(mean_exec_time::numeric, 2) AS mean_ms,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    substring(query for 120) AS q
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat%'
ORDER BY total_exec_time DESC
LIMIT 20;
```

Reset the counters after a test run:

```sql
SELECT pg_stat_statements_reset();
```

## Existing tuning

The migration `20260723000012_index_tuning` added the following covering
indexes based on grepped call sites in `lib/*.ts` — each one maps to a
specific query, not a guess:

- `idx_message_log_appt_channel_state` — reminder idempotency check.
- `idx_notifications_org_unread` — badge count (partial, tiny).
- `idx_payments_org_paidat` — analytics revenue-by-day.
- `idx_appointments_completed_org_starts` — analytics revenue window.

Do NOT add speculative indexes. Every new index costs writes; if
`pg_stat_statements` doesn't show a query in the top 20 for a real workload
it doesn't need one.

## When to add an index

1. Query is in the top 20 by `total_exec_time` for at least a week of
   real traffic.
2. `EXPLAIN (ANALYZE, BUFFERS)` shows a Seq Scan or a heap fetch cost
   dominating.
3. The proposed index is small (partial where possible) and the update
   frequency on the table is low relative to reads.

## When to drop an index

Check `pg_stat_user_indexes` for `idx_scan = 0` after a month of traffic —
those pay write cost with zero read benefit and should be dropped in a
follow-up migration.
