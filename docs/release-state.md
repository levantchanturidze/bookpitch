# Release state — the one current-state document

**Snapshot: 2026-09-03T20:25Z, false-green elimination round deployed (`09ce5c5`).** This file is the single place that says
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

> These are **timestamped observations, not a claim of currency**. Merging this
> very file produces a newer commit and a newer deployment, so the SHA below is
> the one that was verified, not necessarily the one serving traffic when you
> read this. For anything that moves, follow the workflow links at the top.

### Finalization round — 2026-09-04

Status board with per-gate evidence: **`docs/finalization-ledger.md`**. That file
is the resumable record; this one explains why.

Ten defects, in the same two families as before — controls whose terms were set
by the thing they measured, and controls that could never report health.

| Defect | Why it mattered |
|---|---|
| **The soak was graded by production** | `Object.entries(jobs)` filtered against `j.maxAgeMinutes` — the identical defect the monitor had, on the gate that decides whether a 24-hour window counts. A deployment that stopped reporting `retention` dropped it silently from the soak's health check |
| **A 24-hour window could contain no daily work** | Retention's freshness limit is 30 hours, which is longer than the window. A sweep from 26 hours *before* the soak started satisfied `cron-outcomes` for the whole soak |
| **Unhealthy time stayed credited** | Only failed scheduled runs and in-window incidents could invalidate a window. A Sentry outage at hour 23 produced one red tick and SOAK SUCCESS at hour 24 |
| **A failed read was a verdict** | Every deployment-identity problem returned `superseded`, including "alias evidence could not be read". One failed HTTPS request permanently ended the soak with an assertion that was not true |
| **A soak could never recover from an incident** | Exposed by fixing the two above: `no-incident-in-window` was evaluated against the PRE-recovery window, so the incident that caused a restart was still "in the window" afterwards |
| **One cron threshold answered two questions** | 90 minutes was set as a release-blocking gate on the premise that "reminders run every 15 minutes". Measured over 191 scheduled runs across 12.5 days: p50 0.44h, p90 2.08h, p99 3.02h, and **13.7% of gaps exceed 1.5h**. The alarm fired on one interval in seven and nothing could be done about any of them |
| **Partition policies were matched by substring** | `LIKE '%current_org_id()%'` passes on `OR true`, on the wrong role, on `FOR SELECT`, and on a policy with no `WITH CHECK`. An EXISTS also cannot see an *additional* permissive policy — and permissive policies are ORed |
| **The reminder window was on the Node clock** | The whole `[now, now + lead]` interval slid with the application server's clock against a database `starts_at`. Fourth instance of this class here |
| **"Single-use" was a label** | The browser probe's authorisation was a replayable HMAC in a query string — reaching history, referrers and logs, and reusable for its whole lifetime |
| **The receipt was editable** | It lives in a public issue body for 24 hours. Substituting event ids from an older run against an older release would have revalidated perfectly, because every field the tick checked would still agree with every other |

Two things that changed shape rather than being fixed:

- **`cron-staleness` did not become more permissive.** The 90-minute observation
  is still emitted on every run as `cron-delivery-lag`; what changed is which
  one opens an incident. Reminders being late is real customer impact and is
  still reported; it is simply not something an operator can act on.
- **Starting a soak is no longer a form.** `soak.yml` cannot start one at all.
  `release-verify-and-soak.yml` resolves what production is serving, refuses if
  it is not the named SHA on both hosts, refuses while any incident is open,
  runs the real probes, and hands the receipt file to the controller in the same
  job. Removing the input is stronger than validating it.

### False-green elimination round — merged 2026-09-03

| | |
|---|---|
| PRs | **#58** merged as `f2e5a59` (7 commits), **#59** merged as `09ce5c5` (1 commit) |
| CI on #58 | run [33798794156](https://github.com/levantchanturidze/bookpitch/actions/runs/33798794156) — 120 files / **1665 tests, 0 skipped**, 268 Playwright across all 9 required suites, 0 vulnerabilities, secret scan clean, build clean |
| Migrations | run [33801704929](https://github.com/levantchanturidze/bookpitch/actions/runs/33801704929) — **67 applied, none pending**, no drift |
| Invariants | same run, **all seven checks**, including Check 7 for the first time: `current_org_id() is public, 0-arg, returns uuid, LANGUAGE sql STABLE, not SECURITY DEFINER, body pinned, owned by postgres, unwritable by bookpitch_app, and NULL without context` |
| Backup | run [33800659940](https://github.com/levantchanturidze/bookpitch/actions/runs/33800659940), artifact `production-backup-33800659940-1` (id 9910927933), fingerprint `5c9f75110f30141f` — unchanged since the restore, so the same database — downloaded, checksum verified, decrypted and `pg_restore --list`ed in a separate job |
| Deployment | GitHub Deployment **6252144624**, `09ce5c5`, Production, state `success`; `bookpitch.ge` and `www.bookpitch.ge` both 200 with `x-bookpitch-release: 09ce5c5…` |
| Monitor | run [33801885885](https://github.com/levantchanturidze/bookpitch/actions/runs/33801885885) — 2 failures: Sentry (**#44**, below) and `cron-staleness`, which reports its own diagnosis: the most recent *scheduled* run succeeded, GitHub has not delivered the schedule since, so reminders are late and the application is not broken (R-08) |

**Check 7 nearly shipped without ever running.** `migrate.yml` is path-filtered,
and the filter did not include the verifier script the workflow runs. So the
check merged, passed CI against the disposable CI database, and would have sat
unexecuted against production until somebody happened to write an unrelated
migration. PR #59 adds the script to the filter — which is also what caused the
workflow above to run and produce the line quoted in the table.

That is the project's recurring shape, one more time: the control existed, the
tests were green, and the thing it protects was never looked at.

### Remediation round — merged 2026-09-02

| | |
|---|---|
| PR | **#50**, merged as `8f06c9474392f7cb3776e32854a297802a453e8d` (7 commits) |
| CI on the merged head | run [33624814410](https://github.com/levantchanturidze/bookpitch/actions/runs/33624814410) — 115 files / 1551 unit+integration tests, 265 Playwright passed across all 9 required suites, 0 vulnerabilities, build clean |
| Migrations | run [33624814278](https://github.com/levantchanturidze/bookpitch/actions/runs/33624814278) — **66 applied**, no drift |
| Invariants | same run: 21 tenant relations, **exactly one permissive FOR ALL `tenant_isolation` policy per relation whose `USING` and `WITH CHECK` match the expected predicate exactly** |
| Deployment | `8f06c94`, Production, state `success`; `bookpitch.ge` 200 and `www.bookpitch.ge` 308 → 200 |
| Backup | run [33625072107](https://github.com/levantchanturidze/bookpitch/actions/runs/33625072107), artifact `production-backup-33625072107-1` (id 9844468433), fingerprint `5c9f75110f30141f`, verified in a separate job |
| Restore drill | run [33625237297](https://github.com/levantchanturidze/bookpitch/actions/runs/33625237297) against that exact artifact — 66 migrations, 28 tables, 10 organizations, append-only enforced, 13 partitions, 21 RLS policies |
| Monitor | run [33625461452](https://github.com/levantchanturidze/bookpitch/actions/runs/33625461452) — **22/25 passed, 2 paused, 1 informational**; Sentry the only failure |

### Proven in production, not only in CI

**A `housekeeping` dispatch without confirmation now delivers nothing.** Run
[33625380776](https://github.com/levantchanturidze/bookpitch/actions/runs/33625380776):

```
dispatch-guard: failure
housekeeping:   skipped      <- the outbox was NOT drained
reminders:      skipped
retention:      skipped
audit-digest:   skipped
db-partitions:  skipped
```

Before this, `housekeeping` was the *default* and ran with no confirmation —
and it is the job that calls `drainEmailOutbox()`.

**The non-mailing path still works unconfirmed.** Run
[33625425589](https://github.com/levantchanturidze/bookpitch/actions/runs/33625425589):
`db-partitions: success`.

**A failed manual dispatch did not pollute scheduled evidence.** Immediately
after the failure above, `cron-failures` still read
`0/10 recent SCHEDULED cron runs failed (manual dispatches excluded)`.

### Earlier round — merged 2026-09-02

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

> **Corrections.** PR #46 contains **nine** commits (an earlier report said
> eight). PR #50 contains **eight** commits (an earlier report said seven).

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

## Corrective round 2 — deployed and verified

| | |
|---|---|
| PR | **#53**, merged as `dc2a09fe8a946d76501a25cc5652e39808aa0cd9` (11 commits) |
| CI on the exact head | run [33686594686](https://github.com/levantchanturidze/bookpitch/actions/runs/33686594686) — 118 files / 1597 tests, all scanners, 0 vulnerabilities |
| Migrations | run [33744129121](https://github.com/levantchanturidze/bookpitch/actions/runs/33744129121) — **67 applied**, no drift |
| Deployment | GitHub Deployment record **6241882559**, sha `dc2a09f`, Production, `success` |
| Release identity | `bookpitch.ge` and `www.bookpitch.ge` both return `x-bookpitch-release: dc2a09fe…` after redirects |
| Backup | run [33744963354](https://github.com/levantchanturidze/bookpitch/actions/runs/33744963354), artifact `production-backup-33744963354-1` (id 9889255865), fingerprint `5c9f75110f30141f` |
| Restore drill | run [33745143206](https://github.com/levantchanturidze/bookpitch/actions/runs/33745143206) — 67 migrations, **34 RLS policies** (was 21; the 13 partition policies survive a restore) |
| Soak dry-run | run [33744879487](https://github.com/levantchanturidze/bookpitch/actions/runs/33744879487) — **7/7 reads succeeded, no soak started** |

### The security fix, verified in production

Before migration 67, `bookpitch_app` could read every organization's audit
records by naming a partition. After it, measured against production:

```
audit_log_2026_01 | SELECT=false | INSERT=false | rls=true | force=true | policy=1
audit_log_2026_02 | SELECT=false | INSERT=false | rls=true | force=true | policy=1
...
```

The invariant check that now passes **failed against production an hour
earlier**, naming all 13 partitions. Two independent layers: no direct
privileges, and each partition carries its own `tenant_isolation` policy so a
future GRANT filters rather than exposes.

### The soak controller's permissions, proven rather than assumed

```
OK  actions:read production-monitor.yml — 100 scheduled runs, history complete=true
OK  actions:read production-backup.yml  — 18 scheduled runs, history complete=true
OK  actions:read cron.yml               — 100 scheduled runs, history complete=true
OK  deployments:read — deployment 6241882559 sha=dc2a09f state=success env=Production
OK  alias release header — bookpitch.ge=dc2a09f www.bookpitch.ge=dc2a09f
OK  issues:read ops-incident — 12 incident issues visible (paginated)
OK  ops metrics — outboxDead=0 jobs={...}
7/7 reads succeeded. No soak was started.
```

Before this round the workflow lacked `actions: read` and `deployments: read`,
so every one of those would have returned 403 and the controller would have
reported "0 natural observations" — indistinguishable from a quiet window.

---

## Corrective round 2 — what the previous round still got wrong

Independent review found more. The most serious was a live cross-tenant data
exposure that every existing check reported as healthy.

| Defect | Why it mattered |
|---|---|
| **Audit partitions were readable by the app role** | RLS does not inherit downwards. Measured as `bookpitch_app` with no org context: `audit_log` returned **0** tenant rows, `audit_log_2026_09` returned **1705 across 15 organizations**. `INSERT` worked too — a forged audit record attributed to another tenant. `tests/rbac-rls.test.ts` exempted the children with the comment "the parent enforces RLS; partitions inherit", which was the bug |
| The soak workflow lacked `actions: read` / `deployments: read` | Every run-history read would have 403'd and the controller would have reported "0 natural observations" — indistinguishable from a quiet window |
| `deployment_id` was labelled Vercel, compared as GitHub | A real Vercel id could never match; leaving it blank disabled the check. Two ways to be wrong, none to be right |
| `resolveAliases()` ignored the expected SHA | Any HTTP 200 satisfied it, so a healthy response from a different deployment passed |
| Elapsed time accrued while production was broken | Restarts happened only for monitor/incident failures, and began AT the failure — counting the broken hours toward the 24 |
| A job that had never run counted as healthy | The aggregate counted only existing rows with a bad outcome. No row → no count. Only reminders had a freshness gate |
| Housekeeping reported success when it could not send at all | `drainEmailOutbox()` caught provider-init and claim failures, returned zeroes, and the route wrote a successful heartbeat |
| Retention could anonymize a day early | Local-time `getFullYear/getMonth/getDate` on a +04 host. Irreversible, and monitoring used a different cutoff |
| A crash after claiming silenced a reminder forever | `queued` was written before the provider call and treated as delivery — never sent, never retried, never reported missed |
| The reminders route counted organizations, not work | `runReminderTick()` resolves normally when every send fails |
| Sentry receipt proved almost nothing | Local receipt file nothing imported; Node SDK used for the "browser" event; no stack, so maps untested; `sourceMapsResolved` a boolean |

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

## Final false-green round — what corrective round 2 still got wrong

Same pattern again, with one new variety worth naming. Round 2's defects were
controls that reported health while measuring nothing. Several of this round's
are the mirror image: controls that could **never** report health, which is the
same amount of broken and harder to notice, because a gate stuck on ⏳ looks
like patience.

| Defect | Why it mattered |
|---|---|
| **Nothing could put a Sentry receipt into soak state** | `verifySentryReceipt()` required `persisted.nonce`; nothing in the system ever wrote one. The observability gate could not pass by any supported route — the only way would have been hand-editing event ids into the soak issue body, which is the ticked-checkbox evidence the gate replaced. `seedSentryState()` is now the one path in, and `soak.yml` refuses to start without a receipt for the release being soaked |
| The receipt's freshness bound came from the wrong end of the run | The probe fires, *then* the receipt is written. Using the write time as `notBefore` made every receipt reject the very events it had just proved. The bound is now the run's **start** |
| One event id satisfied both runtimes; one symbolicated stack satisfied both | `server.symbolicated \|\| browser.symbolicated` — uploading server maps alone passed while every browser stack stayed minified. Both now prove their own, and identical ids are rejected |
| "Symbolicated" accepted compiled output | The exclusion list covered `/_next/static/chunks/` and `.min.js`, so `.next/server/**/route.js` with context lines counted as original source. Now an allow-list: `.ts`/`.tsx`, not `node_modules/`, not `.next/`, not `webpack-internal:` |
| `verify-sentry.mjs` proved things about a laptop | It initialised `@sentry/node` locally and posted a hand-built envelope. It never contacted the deployment, used the Node SDK for what it labelled the *browser* event, and sent a message with no exception — so there was no stack, and symbolication could not be observed even in principle |
| **The monitor let production decide what got monitored** | The per-job loop iterated `Object.entries(heartbeat.jobs)` and took the staleness threshold from `j.maxAgeMinutes` — the same document. A deployment that stopped reporting a job stopped being asked about it, silently, because a check that is not emitted is not a failing check. The four expected jobs and their limits now live in the monitor (`EXPECTED_HEARTBEAT_JOBS`), pinned against `lib/cron-heartbeat-jobs.ts` by a drift test |
| The reminder claim lease used the Node clock | `created_at` is `DEFAULT CURRENT_TIMESTAMP` — PostgreSQL. The cutoff was `Date.now()` — Vercel. Skew one way steals a live claim and sends the customer a **second** reminder; the other way keeps an abandoned claim alive so the reminder is never retried. Third instance of this class here, after retention and the heartbeat; the cutoff is now computed in SQL |
| The missed-reminder metric was blind to same-day bookings | It counted only `created_at < starts_at - lead_hours`, but `runReminderTick()` puts **no** condition on `created_at` — an appointment booked 8 hours ahead under a 24-hour lead is in the window the moment it exists. So for every booking made inside its own lead window the runtime could try, fail, and the one signal designed to be un-fool-able reported zero |
| **Nothing verified `current_org_id()` itself** | Every one of the 21 policies is `organization_id = current_org_id()`, and the verifier checked only that text. A one-statement `CREATE OR REPLACE` returning a constant leaves all 21 policies looking perfect and every tenant reading one organization. Check 7 now pins schema, arity, return type, language, volatility, `SECURITY DEFINER`, `proconfig`, the exact body, ownership, and that `bookpitch_app` has no `CREATE` on `public` — plus fail-closed behaviour with no context |

Proven non-vacuous rather than assumed: `tests/rls-current-org-id.test.ts`
builds eight deliberately-wrong versions of the function and shows the same
predicate rejects each one, and Check 7 was run against a live database with a
shadowing copy present — it refused with
`2 definition(s) of current_org_id() exist`, then passed again once dropped.

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

Verified against production on 2026-09-03 at `09ce5c5`, in addition to the
above: all seven schema invariants including `current_org_id()` itself; the four
per-job cron heartbeats, each graded against the monitor's own limits rather
than the deployment's; `reminders-missed` under the corrected eligibility
contract; and an encrypted backup taken, downloaded, decrypted and read.

Sentry is the only check that fails for a reason inside the product's control,
and it fails because nothing exists to configure it against.

---

## Corrections — claims that were true when written and are false now

These are listed rather than deleted. The incidents happened; pretending
otherwise would destroy the record of how they were found.

| Claim, still present in some ledgers | Was true | Current truth |
|---|---|---|
| "Production has no database" | 2026-09-01, ~00:00–12:40Z | **False.** Supabase `cglqphbebckvpeyisqqb` restored 2026-09-01. Identity proven by the backup manifest fingerprint `5c9f75110f30141f`, matching pre-loss and post-restore |
| "Actions billing is suspended" | until 2026-08-31T20:55Z | **False.** Restored; real step counts from 2026-09-01T00:05Z |
| "62 migrations" | until 2026-09-01T12:43Z | **False.** 63 applied in production (run `33509215538`); `main` carries **67** (65 → 66 `cron_heartbeat_outcome` → 67 `audit_partition_rls`) |
| "Migration 63 is local only" | until 2026-09-01T12:43Z | **False.** Applied to production exactly once |
| "MARKETING still holds `client.read:contact`" | until migration 63 applied | **False.** Verified absent in production; the two reporting grants remain, which is the complement that stops the check being vacuous |
| "`FIELD_ENCRYPTION_KEY` is malformed" | P15-010 / R-16, until 2026-08-22 | **False.** `production-config-invalid — malformed: 0`, corroborated by an encrypted `email_outbox` row that could not exist unless `encryptField()` succeeded |
| "Nothing is merged" | Phase 16 freeze window | **False.** Phases 16 and 17 merged 2026-09-01 |
| "Production monitor 18/18" / "17/21" / "18/21" / "22/25" | each true on its date | **Stale by construction, and now doubly so.** The denominator moves too: the monitor used to emit one per-job check for each job PRODUCTION reported, so the count depended on the thing being measured. It now emits one per job the MONITOR expects, whether or not the deployment mentions it. Follow the workflow link at the top rather than any number written here. |

---

## The soak has still not executed

The corrected controller has never run against a real window. What exists is:

- a `dry_run` mode that exercises every read and creates nothing;
- unit coverage of the gates, including adversarial cases for each false-success
  path.

Neither is the soak. No soak issue has ever been created, and the controller's
own preconditions refuse to start one. Three of them, in the order they fire:

1. `soak.yml` fails the dispatch if `sentry_receipt` is empty;
2. the controller refuses to start without a receipt, or with one produced for a
   different release — checked at start, where it reads as a setup mistake,
   rather than on tick one, where it would read as a production fault;
3. an open `ops-incident` refuses the start outright, and **#44** is open.

The receipt cannot be produced at all: it is written only by a complete
`npm run verify:sentry` run against the deployed application, and there is no
Sentry project for it to read events back from.

This is the correct state. A 24-hour window with error reporting switched off
would measure nothing and would look exactly like one that measured everything.

## Three different claims about the schema, often conflated

An earlier report said "migrations and invariants pass" as if that were one
fact. It is three, and only the first two have been established in production:

| Claim | What proves it | State |
|---|---|---|
| **Migration ledger is current** | `prisma migrate status` — every migration in `prisma/migrations` is recorded applied, none unfinished or rolled back | ✅ 65 applied |
| **Selected invariants hold** | `scripts/verify-production-invariants.sql` — the specific properties someone thought to write down | ✅ all pass |
| **No arbitrary schema drift** | `prisma migrate diff --from-migrations --to-schema --exit-code` against a shadow database, which catches a column someone added by hand | ✅ in CI, on a disposable database — **not** run against production. `prisma migrate status` does NOT establish this and must not be cited for it: it compares the ledger, not the schema |

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

Only these — as reviewed on the date in the heading above, which is the only
sense in which such a claim can ever be true. "Everything automatable is done"
has now been stated three times and been wrong twice: the round after each one
found more. What can honestly be said is that no known automatable defect is
outstanding, and that the next review is what decides whether that holds.

### 1. Sentry — no workspace exists

`production-observability-unconfigured` fails; issue **#44** is open. Every
uncaught exception in production is discarded.

`sentry.io` serves its marketing page, which means **no authenticated Sentry
session exists**. Creating an account requires accepting Sentry's terms on the
operator's behalf, which is out of scope. This is not a configuration step
someone forgot — there is nothing to configure against.

**Needs a person to:** create or nominate a Sentry organisation and project,
then set, in Vercel Production, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` and
`SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` (the last three are what
uploads source maps at build time and what reads events back afterwards), and
the same three as repository secrets so the soak can re-verify.

Checked read-only on 2026-09-03: Vercel Production holds `SENTRY_ENVIRONMENT`
and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` and neither DSN; the repository holds
**no** Sentry secret at all. Nothing here is a step somebody forgot — there is
still nothing to configure against.

Afterwards `npm run verify:sentry` proves it end to end. It was rewritten this
round and no longer proves anything about the machine it runs on:

| Level | Claim | What it now does |
|---|---|---|
| 1 CONFIGURED | the deployment reports a DSN | asks the **deployed app**, per runtime |
| 2 INITIALISED | the deployed SDK made a client | server probe returns an id; the browser page reports its client |
| 3 EMITTED | captured **and flushed** | both probes report a drained transport |
| 4 INDEXED | retrievable through the Sentry API | polls both event ids |
| 5 VERIFIED | it is *this run's* event, and readable | nonce, release, environment and runtime tag all match, the two ids differ, and both stacks resolve to original `.ts`/`.tsx` frames |

Only level 5 is evidence that an error would reach a human in a form anyone can
act on. Levels 1–3 pass against a DSN pointing at a project that does not
exist; level 4 passes on a stack of unreadable minified chunks.

The browser half is a real headless Chromium loading `/probe/sentry` on the
deployed site, because nothing runnable from Node exercises
`NEXT_PUBLIC_SENTRY_DSN`, the browser bundle or the browser source maps. The
page is reachable only with a short-lived HMAC issued by
`/api/health/sentry-probe/token` (bearer `CRON_SECRET`), and only while
`SENTRY_PROBE_ENABLED` is exactly `"true"` — it 404s otherwise, and the secret
itself never reaches client JavaScript or a URL.

The script also checks the complement of source-map upload: that the `.map`
files are **not** served from the CDN. `deleteSourcemapsAfterUpload` is a build
option, and a build option is a claim until someone fetches the URL.

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

"No engineering work is outstanding" has now been claimed twice and been wrong
both times. The remediation round found eleven defects in the round before it;
this round found nine more, plus one — the verifier path filter — in its own
output, twenty minutes after merging. The claim is only ever as good as the next
review, and it is made here about the work as reviewed on 2026-09-03, not as a
guarantee about work nobody has looked at yet.

What has changed is the *shape* of what keeps being found. The early rounds
found controls that reported health while measuring nothing. This round found
mostly the inverse: gates that could never report health, and a check that could
never run. Those are not softer failures. They are the same defect wearing a
patient face, and a queue of them is how a release stays permanently three days
away.

The soak has not started and **must not** be started while `#44` is open. That
is now enforced rather than intended: the controller refuses to start without a
Sentry receipt for the release under soak, and no receipt can be produced,
because there is no Sentry workspace to produce one against.
