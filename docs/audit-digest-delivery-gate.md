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

### Volume — four different questions, four different numbers

| Field | Meaning |
|---|---|
| `eligibleOwnerMemberships` | Owner rows with an email. One person owning three organisations counts three times. |
| `eligibleOrganizations` | Organisations that would produce at least one message. |
| `distinctNormalizedRecipientAddresses` | Distinct lower-cased, trimmed addresses — **the number of human inboxes**. |
| `expectedDigestMessagesPerRun` | Outbox intents a single enabled run creates: one per (organisation, address) pair, matching what `sendDigestToOwners()` writes and the idempotency key collapses. |

Conflating these is how a single number becomes ambiguous. Seven memberships
could be seven people, or one person with seven organisations.

### Address classification — a partition, not tags

Each **distinct normalized address** falls into exactly one category, assigned
by precedence:

| # | Field | Rule |
|---|---|---|
| 1 | `knownFixtureDomain` | Domain is `bp.test`, `bookpitch.dev` or `isolation.dev` |
| 2 | `reservedTldNonFixture` | Not the above, and at an RFC 2606 / 6761 reserved TLD (`.test`, `.invalid`, `.example`, `.localhost`) |
| 3 | `otherUnclassified` | Neither |

Guaranteed, and asserted against a real database in
`tests/ops-metrics.test.ts`:

```
knownFixtureDomain + reservedTldNonFixture + otherUnclassified
  == distinctNormalizedRecipientAddresses
```

No overlapping diagnostic categories are retained, so no sum of them can be
mistaken for a recipient total.

Interpretation:

- `otherUnclassified = 0` → every distinct address is a fixture domain or an
  unroutable reserved TLD, so the recipients are an artefact of seeding rather
  than real customers.
- `otherUnclassified > 0` → **this does not prove a real customer exists.** It
  means only that the address was not matched by the current fixture rules. A
  staff address, a personal test account, or a demo record all land here.
  Classify further with non-sensitive read-only evidence before concluding
  anything, and never by reading the addresses themselves.

**No production record has been read, printed, deleted, anonymised or modified
to produce these numbers**, and none will be without explicit approval.
