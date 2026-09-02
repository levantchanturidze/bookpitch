// -----------------------------------------------------------------------------
// One authoritative definition of the customer-retention cutoff.
//
// There were two, and they disagreed.
//
//   execution   lib/gdpr.ts built the cutoff in Node:
//                 new Date(now.getFullYear() - N, now.getMonth(), now.getDate())
//               getFullYear/getMonth/getDate are LOCAL-time accessors, so on a
//               host at +04 the cutoff crosses a day boundary four hours before
//               UTC does. Retention is destructive and irreversible: that is a
//               customer's name, email, phone and date of birth redacted up to
//               a day EARLIER than the organization's policy permits.
//
//   monitoring  lib/ops-metrics.ts used `NOW() - N * interval '1 year'`, with
//               no day truncation and the database clock.
//
// Two consequences. The obvious one is the early-redaction bug. The quieter one
// is that the monitor's cutoff sits later in the day than the executor's, so
// `overdueCustomers` could report a backlog that retention was never going to
// clear — a check that is permanently slightly red is one an operator learns to
// ignore.
//
// Both now use the expression below, evaluated by PostgreSQL.
//
// Truncating to the start of the UTC day is deliberate and is the CONSERVATIVE
// direction: `date_trunc('day', now) - N years` is earlier than
// `now - N years`, and the predicate is `updated_at < cutoff`, so an earlier
// cutoff anonymizes strictly fewer rows. Never redacting early matters more
// than redacting promptly.
// -----------------------------------------------------------------------------

/**
 * SQL expression for the retention cutoff, in database time.
 *
 * @param yearsExpr a SQL expression yielding the retention window in years —
 *   a bound parameter for a single organization, or a column such as
 *   `o.customer_retention_years` when joining.
 */
export function retentionCutoffSql(yearsExpr: string): string {
  return (
    `((date_trunc('day', (NOW() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC')` +
    ` - make_interval(years => ${yearsExpr}))`
  );
}
