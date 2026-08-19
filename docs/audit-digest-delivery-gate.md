# Audit digest delivery gate

**Status: delivery is OFF.** Nothing is queued and nothing is sent.

## Why this exists

The audit digest emails a 7-day activity rollup to every organisation owner.
Production reports **7 eligible owner mailboxes** while the service has not been
sold, so those recipients are unreconciled — they may be seed, fixture, demo or
internal records rather than customers who expect mail.

Two Phase 15 changes made that urgent rather than theoretical:

- **P15-009** routed the digest through `email_outbox`, so it now genuinely
  delivers instead of failing silently at the provider.
- **P15-004** put it on the **hourly** schedule, so it fires automatically
  rather than being triggered by hand.

Together those mean that the moment `FIELD_ENCRYPTION_KEY` is corrected, the
next hourly cron would have queued mail to all 7. This gate stops that.

## How it works

`AUDIT_DIGEST_ENABLED` must be **exactly `true`** to permit delivery.

| Value | Mode | Delivers? |
|---|---|---|
| unset | `disabled` | No |
| `true` (surrounding whitespace tolerated) | `enabled` | **Yes** |
| `false`, `FALSE`, empty | `disabled` | No |
| `1`, `yes`, `TRUE`, `True`, `on`, `enabled`, `y`, `tru`, `"true"`, anything else | `disabled_malformed` | No |

Fails closed by design: an ambiguous value must never be the thing that starts
sending mail to people. A malformed value is reported *separately* from an
absent one, so a botched attempt to enable it is visible rather than silent —
but both block delivery identically.

Enforced at three levels, because a gate guarding one caller has a hole in it:

1. `runDigestForAllOrgs()` returns before querying organizations, building a
   digest, encrypting anything, or writing a row.
2. `sendDigestToOwners()` re-checks — it is exported and callable directly.
3. `POST /api/cron/audit-digest` returns `200 {ok, skipped:true, mode}`.

## Why the endpoint returns 200 rather than failing

A paused job is not a broken job. Returning an error would make the hourly cron
red for as long as the gate stays shut, burying genuine cron faults under known
noise. The paused state is surfaced by the monitor instead, where it belongs.

## Monitoring

`audit-digest-stalled` reports a third state — **`PAUSE`**, rendered as
`DISABLED BY CONFIGURATION` — which is neither PASS nor FAIL:

- it is **not a PASS**: claiming health would imply digests are being delivered;
- it is **not a FAIL**: paging someone every 30 minutes about a deliberate
  decision is how alerting gets ignored;
- it is excluded from the "N/M checks passed" count and reported separately as
  "N paused by configuration";
- it **never opens an incident**, so the paused state cannot generate repeat
  noise;
- an incident already open is closed as *paused*, explicitly not as
  *recovered* — a false "recovered" in an incident's audit trail is a lie.

Everything else keeps working. `tests/production-monitor.test.ts` includes a
case asserting that with the digest paused, dead-lettered outbox rows and an
invalid security env var both still FAIL.

The check returns to real evaluation the instant delivery is enabled — the gate
suppresses delivery, not the monitoring of it.

## Enabling it later

Do not enable until the 7 recipients are reconciled and you accept that they
will receive mail.

1. Reconcile using the classification in `/api/health/ops` (see below).
2. Set `AUDIT_DIGEST_ENABLED=true` on the Production environment in Vercel.
3. Redeploy — existing deployments do not inherit changed environment values.
4. Confirm the monitor's `audit-digest-stalled` leaves `PAUSE`.
5. Watch the first run: expect exactly one outbox row per eligible recipient
   per ISO week, and none on subsequent hourly runs.

## Reconciling the recipients

`/api/health/ops` reports the eligible owner mailboxes classified **by address
shape only**. Counts leave the server; no address, name or identifier does.

| Field | Meaning |
|---|---|
| `eligibleRecipients` | Owner memberships with a non-null email |
| `recipientsFixtureDomain` | At `bp.test`, `bookpitch.dev` or `isolation.dev` — this repository's seed/fixture domains |
| `recipientsReservedTld` | At `.test`, `.invalid`, `.example` or `.localhost` — RFC 2606 / RFC 6761 reserved, cannot receive mail |
| `recipientsOther` | Neither of the above — **these are the ones that could belong to a real person** |

The categories deliberately overlap: `bp.test` is both a fixture domain and a
reserved TLD, while `bookpitch.dev` is a fixture domain on a **real** TLD and is
therefore theoretically deliverable. `recipientsOther` is the number that
matters for the reconciliation.

Interpretation:

- `recipientsOther = 0` → every eligible recipient is fixture or unroutable, so
  the 7 are an artefact of seeding rather than real customers.
- `recipientsOther > 0` → identify those records before enabling delivery.

**No production record has been read, printed, deleted, anonymised or modified
to produce these numbers**, and none will be without explicit approval.
