# Release state — the one current-state document

**Snapshot: 2026-09-02, post-remediation.** This file is the single place that says
what is true *now*. Every phase ledger is a historical record of what was true when it was
written; where a ledger and this file disagree about the present, this file
wins and the ledger is wrong only in tense, not in fact.

Status that changes on its own — monitor results, soak progress, incident
state — is **not** restated here, because a number copied into a document is
stale the moment it is written. Those live in:

- **Production monitor** — [`Production monitor` workflow runs](https://github.com/levantchanturidze/bookpitch/actions/workflows/production-monitor.yml)
- **Soak** — the open `soak`-labelled issue, updated every 30 minutes by
  `.github/workflows/soak.yml`
- **Open incidents** — [`ops-incident` label](https://github.com/levantchanturidze/bookpitch/issues?q=is%3Aissue+label%3Aops-incident)

---

## This release — measured, not asserted

| | |
|---|---|
| `main` | **`ffd42c1e2acb7c48f22a04f98c37ad23d428a10b`** (merge of PR #46) |
| CI on the exact merged head | run [33591959823](https://github.com/levantchanturidze/bookpitch/actions/runs/33591959823) — success |
| Migrations | run [33591959724](https://github.com/levantchanturidze/bookpitch/actions/runs/33591959724) — **65 applied**, 0 unfinished, 0 rolled back, `Database schema is up to date!` |
| Production invariants | same run, read-only: **21 tenant relations** RLS enabled + FORCED + `tenant_isolation` using `current_org_id()`; MARKETING has no `client.read:contact` and keeps both reporting grants; 2026-09 and the next 3 months exist with correct bounds; `audit_log_default` empty |
| Deployment | `dpl_2W1ncgkgXWfxqeYbw21x3cV2qJ3u`, built from `ffd42c1`, aliased to `bookpitch.ge` and `www.bookpitch.ge` |
| Deployed app exercised | `/api/health` 200 `{"ok":true}`; `/signin` `/signup` `/privacy` 200; tokenless `/api/onboard` 400; `/api/health/ops` 401 |
| Backup | run [33595021207](https://github.com/levantchanturidze/bookpitch/actions/runs/33595021207); GitHub artifact `production-backup-33595021207-1`, artifact id **9833092217**, containing `bookpitch-prod-20260902T053…Z-r33595021207a1.tar.age` — 307,464 encrypted bytes, identity fingerprint `5c9f75110f30141f`, 565 restorable entries, decrypted and verified **in a separate job** |
| Restore drill | run [33597695162](https://github.com/levantchanturidze/bookpitch/actions/runs/33597695162) against that exact artifact — 65 migrations, 28 required tables, 10 organizations, append-only triggers present and `UPDATE` rejected, 13 partitions, 21 RLS policies, `bp_create_monthly_partition()` present |
| Monitor | run [33597697501](https://github.com/levantchanturidze/bookpitch/actions/runs/33597697501) — **20/23 passed, 2 paused by configuration, 1 informational**; the single failing check is Sentry |

> **Correction (2026-09-02):** PR #46 contains **nine** commits, not eight. An
> earlier report said eight.

### The two fixes that had to be proven in production, not just in CI

**A manual cron dispatch no longer runs everything.** Dispatch
[33596343699](https://github.com/levantchanturidze/bookpitch/actions/runs/33596343699)
with `only=housekeeping`:

```
dispatch-guard: success
housekeeping:   success
reminders:      skipped     <- the whole point
retention:      skipped
audit-digest:   skipped
db-partitions:  skipped
```

Before this, a blank selection ran all five, reminders included.

**The heartbeat distinguishes invocation from completion.** Scheduled run
[33596375712](https://github.com/levantchanturidze/bookpitch/actions/runs/33596375712)
wrote `reminders | units=10`, and the monitor read it back:

```
PASS  cron-heartbeat-stale  reminders last completed 0.3h ago (limit 6.0h), handling 10 organization(s)
```

**Incidents.** #47 (`cron-staleness`) and #48 (`cron-heartbeat-stale`) opened on
the first post-deploy run and were auto-closed on the next once a scheduled
cron arrived — the new check working, then recovering, unattended.

**#38's full chronology**, because "it was closed on bad evidence and then
closed properly" skips the part that matters:

| When | What happened |
|---|---|
| 2026-09-01 00:30Z | Opened automatically: 10/10 recent cron runs failed |
| 2026-09-01 14:32–14:44Z | Five `workflow_dispatch` runs, verifying the endpoint by hand after the database restore |
| 2026-09-01 18:45Z | **Auto-closed as "recovered"** on `1/10 recent cron runs failed`. The scheduled-only window at that moment was **6/10** — the manual runs had displaced six real failures |
| 2026-09-02 ~03:00Z | **Reopened** with the measurement, before any fix was deployed |
| 2026-09-02 05:32Z | Closed again on `0/10 recent SCHEDULED cron runs failed (manual dispatches excluded)`, from the corrected model on the deployed fix |

The second close is legitimate not because the number is better but because ten
genuine scheduled successes had accumulated, and because a manual dispatch can
no longer contribute to it or close an incident at all.

**#44 (Sentry) remains open and is the only failing check.**

---

## Remediation round — defects found in the previous round's own work

The work that closed the six audit defects introduced or left several of its
own. They are listed here rather than quietly fixed, because the pattern is the
point: each one was a control that reported health while measuring nothing —
the same shape it was written to eliminate.

| Defect | Why it mattered |
|---|---|
| `housekeeping` classified as unable to contact customers, **and made the dispatch default** | `runHousekeeping()` calls `drainEmailOutbox()` — it is the component that DELIVERS every queued message. Naming the delivery worker as the one-click default was worse than the blank default it replaced, because it looked deliberate |
| A cron job could fail every unit of work and still report success | The route wrote the heartbeat unconditionally, returned 200 regardless, and the monitor checked only heartbeat AGE. Three signals, all green, none measuring whether the work happened |
| Heartbeat timestamps came from `new Date()` | The Node clock. A skewed instance could write a heartbeat from the future and keep a dead job alive indefinitely |
| The audit digest swallowed every error | A bare `catch {}` documented as "any other failure is also non-fatal". `encryptField()` throwing on a malformed key — the P15-010 incident — was swallowed, so the digest queued nothing and reported success |
| The soak re-derived its window start every tick | A restart survived only while the failing run stayed in the fetched page. Once it aged out the window reverted and the soak claimed hours it had never held uninterrupted |
| The soak fetched one page of 40 runs | A 24-hour window holds ~48 monitor observations, so an early failure aged out unseen |
| A missing deployment record **skipped** the identity check | `if (evidence.deployment && …)` — the soak stopped knowing which code it measured, while a comment claimed a gate would catch it |
| Sentry receipt was a workflow checkbox | `SOAK_SENTRY_RECEIPT_VERIFIED=true`, ticked by an operator. A claim, not evidence |
| The RLS verifier matched policy **text** for `current_org_id()` | `USING (organization_id = current_org_id() OR true)` passes. So does `USING (true)` alongside a second policy that mentions it — permissive policies are ORed, so one extra defeats all the others |
| No Sentry source maps were ever uploaded | `next.config.ts` was never wrapped in `withSentryConfig`, so a production stack trace is unreadable minified frames |
| "Accepted by ingest" treated as receipt | Sentry answers 200 to envelopes it then drops, and the id returned is the client's own |

Two things that were **not** defects, established by measurement rather than
assumed:

- **Reminder duplicate-prevention was already correct.** `claim()` takes
  `FOR UPDATE` and dedupes on (appointment, channel). Three ticks produce
  exactly one sent email; the three *failed* SMS rows are deliberate retries of
  a failed send, not duplicates.
- **A scheduler gap does not lose future appointments.** The window is sliding,
  so a later tick still covers everything that has not started. The
  unhealable case is an appointment that starts *during* the gap — now counted
  directly by `reminders-missed`.

---

## The seven states a change can be in

The single biggest source of contradiction across the ledgers is that
"done" was used for all of these. They are not the same claim.

| State | Means |
|---|---|
| **implemented** | the code exists in a working tree |
| **committed** | it is in git history somewhere |
| **pushed** | a remote has it |
| **merged** | it is an ancestor of `origin/main` |
| **deployed** | that exact SHA is serving `bookpitch.ge` |
| **production-verified** | a check ran *against production* and passed |
| **soak-verified** | it survived an uninterrupted 24h window under §13 |
| **human-approved** | a person with the authority signed it off |

Nothing is soak-verified — the soak has not started, and must not while #44 is
open. Nothing has been human-approved.

---

## Phases 15, 16, 17 — where each actually stands

| Phase | implemented | merged | deployed | production-verified | soak-verified | human-approved |
|---|---|---|---|---|---|---|
| **15** launch readiness | ✅ | ✅ | ✅ | ✅ except the items below | ❌ | ❌ |
| **16** reconciliation | ✅ | ✅ `e69795b` (PR #36) | ✅ | ✅ incl. F16-012 | ❌ | ❌ |
| **17** stabilization | ✅ | ✅ `86e09a9` (PR #35) | ✅ | ✅ except Sentry (P17-007) | ❌ | ❌ |

---

## Corrections — claims that were true when written and are false now

These are listed rather than deleted. The incidents happened; pretending
otherwise would destroy the record of how they were found.

| Claim, still present in some ledgers | Was true | Current truth |
|---|---|---|
| "Production has no database" | 2026-09-01, ~00:00–12:40Z | **False.** Supabase `cglqphbebckvpeyisqqb` restored 2026-09-01. Identity proven by the backup manifest fingerprint `5c9f75110f30141f`, matching pre-loss and post-restore |
| "Actions billing is suspended" | until 2026-08-31T20:55Z | **False.** Restored; real step counts from 2026-09-01T00:05Z |
| "62 migrations" | until 2026-09-01T12:43Z | **False.** 63 applied in production (run `33509215538`); `main` carries **65** |
| "Migration 63 is local only" | until 2026-09-01T12:43Z | **False.** Applied to production exactly once |
| "MARKETING still holds `client.read:contact`" | until migration 63 applied | **False.** Verified absent in production; the two reporting grants remain, which is the complement that stops the check being vacuous |
| "`FIELD_ENCRYPTION_KEY` is malformed" | P15-010 / R-16, until 2026-08-22 | **False.** `production-config-invalid — malformed: 0`, corroborated by an encrypted `email_outbox` row that could not exist unless `encryptField()` succeeded |
| "Nothing is merged" | Phase 16 freeze window | **False.** Phases 16 and 17 merged 2026-09-01 |
| "Production monitor 18/18" / "17/21" / "18/21" | each true on its date | **Stale by construction.** See the workflow link above. the gate count is now **23** plus one informational line, and the latest run is 20/23 with 2 paused |

---

## Three different claims about the schema, often conflated

An earlier report said "migrations and invariants pass" as if that were one
fact. It is three, and only the first two have been established in production:

| Claim | What proves it | State |
|---|---|---|
| **Migration ledger is current** | `prisma migrate status` — every migration in `prisma/migrations` is recorded applied, none unfinished or rolled back | ✅ 65 applied |
| **Selected invariants hold** | `scripts/verify-production-invariants.sql` — the specific properties someone thought to write down | ✅ all pass |
| **No arbitrary schema drift** | `prisma migrate diff --from-migrations --to-schema --exit-code` against a shadow database, which catches a column someone added by hand | ✅ in CI, on a disposable database — **not** run against production |

The third is the one that is easy to over-claim. Prisma's drift detection needs
a shadow database it can create and drop; pointing it at production is not
something to do casually. So production is verified against the invariants
somebody wrote, not against every possible divergence, and a hand-made change
that no invariant happens to cover would not be caught.

---

## The soak criterion

Earlier ledgers stated the target as "21/21 with 2 paused", which cannot be
satisfied: if 2 of 21 are paused then at most 19 can pass. The count also moves
whenever a check is added — PR #46 adds two — so any fixed number is wrong the
next time the monitor changes.

The criterion does not mention a total at all:

> **Every applicable check passed, only explicitly accepted checks paused, and
> zero checks failed** — held without interruption for 24 hours, on one
> deployment, with at least six *natural* monitor observations.

Encoded in `scripts/soak-controller.mjs` and asserted in
`tests/soak-controller.test.ts`. Time alone can never satisfy it: a
release-critical failure resets the window to the moment of failure, and only
`event === 'schedule'` runs count as evidence.

### Accepted paused checks

| Check | Why paused | Recorded in |
|---|---|---|
| `audit-digest-stalled` | `AUDIT_DIGEST_ENABLED` is not `true` — a deliberate pre-launch gate | `docs/audit-digest-delivery-gate.md` |
| `production-provider-mocked` | `SMS_PROVIDER` and `PAYMENT_GATEWAY` on `mock`, both accepted deferrals | `docs/deferred-features.md` § Outbound providers |

`EMAIL_PROVIDER` is **not** deferrable. A mocked email provider means nobody
can complete signup, and it is now reported as a fault rather than a pause.

---

## What is blocked, and on whom

Only these. Everything automatable is done.

### 1. Sentry — no workspace exists

`production-observability-unconfigured` fails; issue **#44** is open. Every
uncaught exception in production is discarded.

`sentry.io` serves its marketing page, which means **no authenticated Sentry
session exists**. Creating an account requires accepting Sentry's terms on the
operator's behalf, which is out of scope. This is not a configuration step
someone forgot — there is nothing to configure against.

**Needs a person to:** create or nominate a Sentry organisation and project,
then set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` in Vercel Production.
Afterwards `npm run verify:sentry` proves it end to end — it distinguishes
CONFIGURED / INITIALISED / EMITTED / **RECEIVED**, and only level 4 is
evidence that an error would reach a human. Levels 1–3 all pass against a DSN
pointing at a project that does not exist.

### 2. Legal review — `LEGAL_DOCUMENT_STATUS` is `'draft'`

`OPERATOR_IDENTITY` is all-null: no legal name, registration number, postal
address or contact. The pages render a clearly-marked gap rather than a
plausible-looking placeholder, which is honest but is not a privacy notice.

**Needs a person to:** complete `docs/legal-review-checklist.md` and flip the
constant. This can never be inferred from technical completeness, and no amount
of green CI is evidence for it.

### 3. Designated test mailbox — none nominated

No mailbox has been named, so signup and email-receipt UAT **has not been
performed** and is not claimed anywhere. Inspecting an inbox is the only thing
that proves delivery; a 200 from the provider is not.

### 4. Branch protection — accepted risk, not a gap

Unavailable for private repositories on the current plan. Recorded as **R-07**
in `docs/phase-15-risk-register.md` with explicit owner acceptance for launch
and pilot, mitigated by verifying each required check against the exact head
SHA before merging. This is a documented accepted risk, not an outstanding
item.

---

## Release verdict

**ENGINEERING COMPLETE — EXTERNAL BLOCKED**, on items 1–3 above.

"No engineering work is outstanding" was claimed once before and was wrong: the
remediation round above found eleven defects in that round's own output. The
claim is only ever as good as the next review, and it is made here about the
work as reviewed on 2026-09-02, not as a guarantee.

The soak has not started and **must not** be started while `#44` is open: an
unobserved window proves nothing, which is why the controller has an
`observability` gate that refuses to pass without verified Sentry receipt.
