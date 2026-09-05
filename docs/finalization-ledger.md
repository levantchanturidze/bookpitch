# Bookpitch — finalization ledger

The resumable, gate-by-gate record of the Phase 15–17 finalization program.

**This file is a status board, not a narrative.** `docs/release-state.md` remains
the current-state prose document and explains *why* things are the way they are;
the phase ledgers remain historical records of what was true when written. This
file answers one question only: **which gates are proven, by what evidence.**

Every row carries durable evidence — a SHA, a run id, a deployment id, an
artifact id, an event id — or it is not passed. Prose is not evidence. A checked
box is not evidence. "The code for this exists" is not evidence.

## Status vocabulary

| Status | Means |
|---|---|
| `NOT STARTED` | no work has begun |
| `IN PROGRESS` | being worked on now |
| `BLOCKED — MANUAL` | waiting on an action only a human can take; the exact action is named |
| `FAILED — ENGINEERING` | tried, does not work, is being fixed |
| `PASSED — LOCAL` | proven on a developer machine only |
| `PASSED — CI` | proven by a CI run against the disposable CI database |
| `MERGED` | an ancestor of `origin/main` |
| `DEPLOYED` | that exact SHA is serving `bookpitch.ge` |
| `PRODUCTION VERIFIED` | a check ran *against production* and passed |
| `SOAK VERIFIED` | survived an uninterrupted 24-hour window on one release |

`PASSED — CI` is deliberately weaker than `PRODUCTION VERIFIED`. The CI database
is disposable and seeded; production is neither. A check that is green in CI and
has never run against production is `PASSED — CI`, no matter how good the test
is.

---

## Baseline — revalidated 2026-09-04T18:10Z (superseded by the evidence below)

Observed directly, not carried over from any earlier summary.

| Fact | Value | How observed |
|---|---|---|
| `origin/main` | `6452f3da7a89f996417240ffff61d7522e680f7a` | `git rev-parse origin/main` |
| Local tree | clean, `main`, 0 ahead / 0 behind | `git status`, `git rev-list --left-right` |
| Open PRs | none | `gh pr list --state open` |
| Open incidents | **#67** (Sentry). #44 is the CANONICAL issue for that marker and is wrongly closed — a PR body containing `closes #44` closed it while the check was still failing, and the next monitor run raised #67. The corrected reconciler reopens #44 and closes #67 as a duplicate on its next run | `gh issue list --label ops-incident --state all` |
| Production deployment | id **6252458484**, sha `6452f3d`, state `success` | GitHub Deployments API |
| Aliases | `bookpitch.ge` 200, `www.bookpitch.ge` 308→200, both `x-bookpitch-release: 6452f3d…` | `curl -sI` |
| Health body | exactly `{"ok":true}` | `curl` |
| Migrations | 67 applied, none pending; migration LEDGER up to date | run [33801704929](https://github.com/levantchanturidze/bookpitch/actions/runs/33801704929). Said "no drift" — see A32: `migrate status` never established that |
| Invariants | all 7 checks pass against production | same run |
| Latest backup | run [33800659940](https://github.com/levantchanturidze/bookpitch/actions/runs/33800659940), artifact `production-backup-33800659940-1` (id 9910927933) | Actions API |
| Latest restore drill | run [33745143206](https://github.com/levantchanturidze/bookpitch/actions/runs/33745143206), 2026-09-03T10:35Z — **against an older artifact** | Actions API |
| Soak | **never started.** Zero `soak`-labelled issues, ever | `gh issue list --label soak --state all` |
| Branch protection | unavailable on this plan (R-07, accepted) | API returns 403 "Upgrade to GitHub Pro" |
| Sentry secrets in GitHub | **none.** Only `ADMIN_MIGRATE_DATABASE_URL`, `APP_URL`, `BACKUP_AGE_PRIVATE_KEY`, `CRON_SECRET`, `DATABASE_URL_SUPERUSER_MIGRATE` | `gh secret list` |
| Sentry vars in Vercel Production | `SENTRY_ENVIRONMENT` and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` only — **neither DSN**, no auth token | `vercel env ls production` |
| Sentry account | **no authenticated session.** `sentry.io/organizations/new/` redirects to `/auth/login/` | browser, read-only |

---

## Gates

### A. Engineering

| # | Gate | Status | Evidence |
|---|---|---|---|
| A1 | Soak state machine — recovery, transient vs terminal | `MERGED` | `SOAK_HEALTH_GATES` / `SOAK_PROGRESS_GATES`, every gate classified and asserted to be in exactly one; unreadable identity evidence is now transient, a different release is terminal, an unpinned soak is `blocked`; controlled-clock test proving hour-23 failure cannot become hour-24 success |
| A2 | Authoritative heartbeat contract shared by monitor + soak | `MERGED` | `scripts/heartbeat-contract.mjs`; both consumers import it; 18 tests in `tests/heartbeat-contract.test.ts` incl. omitted/unknown/empty maps, remote threshold inflation and non-numeric ages |
| A3 | Retention success strictly inside the effective window | `MERGED` | new `retention-in-window` soak gate; retention's 30h freshness limit is longer than the 24h window, so `cron-outcomes` alone could certify a window the sweep never ran in |
| A4 | Exact partition-policy verification | `PRODUCTION VERIFIED` | check 4f now matches count, name, command, permissive mode, roles, exact `USING` and exact `WITH CHECK` per partition; 11 injected-failure cases in the CI suite; all 10 adversarial mutations proven refused against a live database |
| A5 | Sentry receipt + source-map verification hardening | `MERGED` | symbolication bound to each runtime's own probe source (`PROBE_SOURCES`); public-map check fails closed on any ambiguity and probes both the declared `sourceMappingURL` and `<chunk>.map`; receipt is HMAC-signed over 10 bound fields and re-authenticated every tick |
| A6 | Genuinely single-use browser probe challenge | `MERGED` | migration 68 `sentry_probe_challenge`; atomic `UPDATE … WHERE consumed_at IS NULL`; id in an HttpOnly `__Host-` cookie, nothing in the URL; replay/expiry/concurrency/leakage tests incl. 8 concurrent redemptions yielding exactly one winner |
| A7 | Automatic Sentry→soak handoff | `MERGED` | `release-verify-and-soak.yml` does all six steps in one job; `soak.yml` can no longer start a soak at all — `start`, `release_sha`, `deployment_id` and `sentry_receipt` inputs removed |
| A8 | Reminder clock + eligibility contract, shared | `MERGED` | `lib/messaging/reminder-eligibility.ts`; selection window moved into SQL (was `new Date()` compared against a DB `starts_at`); clock-skew tests both directions with `toFake: ['Date']` |
| A9 | Cron threshold contradiction (1.5h vs 6h) | `MERGED` | measured 191 scheduled runs / 12.5 days: p50 0.44h, p90 2.08h, p99 3.02h, 13.7% of gaps > 1.5h, one > 6h (the billing outage). Split into `cron-delivery-lag` (90m, informational) and `cron-staleness` (6h, gating) |
| A10 | Documentation reconciliation | `MERGED` | operations.md env table repaired (3 GitHub rows were orphaned below the Sentry prose and rendered as text) + the 3 Sentry build/API vars added (the probe-enable flag documented then was removed on 2026-09-04, see A19); `pg_restore --list` no longer described as "restorable"; superseded banners on the phase-17 Sentry instructions; release-state records this round and stops claiming "everything automatable is done" unqualified |

| A13 | Receipt survives its own lifecycle | `MERGED` | `receiptDigest()` binds `notBefore` AND `verifiedAt`; seeding dropped one and overwrote the other while keeping the digest, so the first revalidation hashed a different document. Both preserved verbatim; the bound is read through `soakFreshnessBound()` |
| A14 | Informational results excluded from the process verdict | `MERGED` | one `summariseResults()` for the summary, step summary and exit code; a complement test applies the OLD predicate to prove the new tests discriminate |
| A15 | Re-runs are not natural evidence | `MERGED` | `scripts/run-evidence.mjs`: scheduled AND `run_attempt === 1`; ordering on the immutable `created_at`; re-runs reported on their own INFO line |
| A16 | All verdict-relevant soak state signed | `MERGED` | `soakStateDigest` over 8 fields plus the receipt digest; replay anchored to the soak issue's creation time |
| A17 | Truncated organizations counted as unreached work | `MERGED` | measured in the fixture DB: 192 organizations dropped, HTTP 200, healthy heartbeat |

| A18 | A wrongly closed incident reopens rather than duplicating | `MERGED` | found in production: a PR body reading "the verifier closes #44 by evidence" was parsed by GitHub as a closing keyword and closed the incident while its check was still failing. `canClose: false` governs this monitor, not GitHub's automation. A still-failing check reopens its own issue. **Superseded by A25**: that first version chose the highest-numbered closed issue and only looked at closed issues when none was open, so against the live #44/#67 state it did nothing — it commented on #67 and left #44 closed |

| A19 | Every semantic leaf signed, under a schema version | `MERGED` | canonical deep serialisation; unknown top-level fields refused; only `lastTickAt` excluded; exhaustive nested-mutation tests |
| A20 | Same-issue replay detectable | `MERGED` | checkpoint comments as an external monotonic reference — rollback, deletion, forking and reordering all fail closed. Documented limitation: an actor with repo write can delete the whole chain, and the controller then refuses rather than trusting the body |
| A21 | Re-runs resolve to attempt 1 rather than vanishing | `MERGED` | `resolveRun()` fetches `/attempts/1`; an unreadable one is kept and marked unresolved; ordering and pagination on immutable `created_at` |
| A22 | The unattended proof cannot be refreshed by hand | `MERGED` | provenance confirmed against GitHub's run record, not the environment; restamping an old receipt refused |
| A23 | Cadence separated from expiry, with measured margin | `MERGED` | 4h cadence / 14h expiry; survives one dropped schedule at p95 lag with ~1.7h spare; 6 probe pairs a day |
| A24 | Ongoing delivery monitoring, soak or no soak | `MERGED` | `sentry-reverify.yml` verifies on schedule regardless; `scripts/sentry-incident.mjs` raises a deduplicated incident and only a complete pass closes it; unavailable / indeterminate / broken are distinct; all output redacted |
| A25 | Canonical incident is the oldest issue | `MERGED` | duplicates closed after the canonical is reopened, so there is never a moment with no open incident for a failing condition |
| A26 | Email DNS — suspected defect DISPROVED | `PRODUCTION VERIFIED` | re-verified by `dig` 2026-09-04: SPF, DKIM, bounce MX and DMARC (`p=none`) all present. They live at `send.send.bookpitch.ge` — a `send.` child of the sending domain — so a query aimed at `send.bookpitch.ge` finds nothing and wrongly concludes they are missing. That misreading is what Phase 13 recorded as "unverified" |

| A27 | A PR cannot close an issue on merge | `PRODUCTION VERIFIED` | it happened TWICE to #44 — PR #66 in prose, PR #72 from inside a code span while documenting PR #66. Backticks do not protect against GitHub's closing parser. `scripts/check-pr-body.mjs` runs as the `Pull request body` CI job; it passed on its own PR (#73) and refuses the exact sentences that caused both closures. **Superseded by A31** on two counts: it ran only on `opened`/`synchronize`/`reopened`, so an edit after the check went green was never re-examined; and "required" overstated it — see the enforcement note under *What is checked and what is merely observed* |

| A28 | The Sentry verifier acts only on the incident it owns | `MERGED` | `sentry-incident.mjs` passed ONE result to `reconcileIncidents()`, whose orphan sweep retires incidents no check reported — reasonable when the caller reports every check, and it reports one. Reproduced against the real reconciler: outcome `unavailable` with #44 plus an `ops-metrics` and a `backup-workflow-stale` incident open produced `toClose -> [90 (orphaned), 91 (orphaned)]`, and the caller closes each with *"Resolved by end-to-end verification."* A run that could not reach Sentry at all would have declared two unrelated incidents resolved by evidence it never gathered. `reconcileIncidents` now takes `ownedCheckIds`, defaulting to **the ids present in `results`** — a partial caller retires nothing. The monitor declares `'all'` at its call site because it alone reports the complete set. **Reachable, not realised**: verified against the issue history — every open `ops-incident` during the verifier's lifetime has been #44 or its duplicate #67, so the sweep never had an unrelated incident to take |
| A29 | An unknown outcome blocks instead of disappearing | `MERGED` | `resolveRun()` keeps an unreadable first attempt and marks it `unresolved` — then left the LATEST attempt's number on it, and `isNaturalObservation()` required attempt 1, so both consumers filtered it straight back out. The fix protected the record and the predicate discarded it one line later. Reproduced through `evaluateSoak()`: with eight clean observations around it an unreadable in-window first attempt returned **`success`**, while the same attempt retrieved as a failure returned `awaiting-recovery`. Reading the outcome decided the verdict; failing to read it decided the verdict too, the other way, in the direction that ships. Unknown is now an observation: `monitor-clean` excludes it, the new `evidence-resolved` gate blocks on it, and the monitor's new `cron-evidence-unresolved` check fails on it. It does **not** restart the window — a GitHub read error is not a production failure. Also fixed: a re-run whose latest attempt is still in progress carried that attempt's status, so `status === 'completed'` dropped the record before its first attempt was ever resolved |
| A30 | The chain tip must agree exactly | `MERGED` | `verifyCheckpointChain()` refused a rolled-back body and a forked, deleted or reordered chain — and returned `ok: true` when the body was AHEAD of the tip. The persistence order is body first, checkpoint second, and the comment at that call site claimed the next tick "reads as a gap and refuses". It did not: the one crash the ordering was designed around was the one case that passed silently, certifying a tick with no external anchor at all. Exact tip agreement is now required, and no recovery protocol is offered — re-anchoring would write the missing checkpoint from the state under suspicion. Separately, `ghAll()` now reports truncation: GitHub returns issue comments **oldest first**, so exhausting the page budget drops the newest checkpoints and leaves a stale tip the body legitimately sits ahead of |
| A31 | The PR guard runs when the text it guards changes | `MERGED` | `pull_request` with no `types:` means `opened`, `synchronize`, `reopened`. Not `edited`. A PR could be opened clean, pass, then have "closes #44" added to its body and merge with a green tick — the exact failure the guard exists to prevent, reachable by editing a textarea. **The first fix was wrong and production said so.** Adding `edited` to `ci.yml` and skipping the heavy jobs on it produced, on PR #76, run [33961699126](https://github.com/levantchanturidze/bookpitch/actions/runs/33961699126): the edit created a NEWER run in which the test suite was `skipped`, and `gh pr checks` then read `Lint, type-check, test, and build — skipping` for a head whose real results sat in an earlier run. A displaced result that reads as "nothing wrong" is this project's oldest failure mode, reintroduced for a check that reads two strings. The guard now lives in its own `pr-body.yml` with its own trigger and concurrency group; `ci.yml` keeps the default event set and every check name in it means what it says. The check keeps the name `Pull request body`, so earlier citations stay valid |
| A32 | A drift check that actually looks at the schema | `MERGED` | `migrate.yml` had a step named **"Verify no drift after apply"** that ran `prisma migrate status`, and every ledger citing that run repeated the claim. `migrate status` compares the `_migrations` table with the migrations directory: it is a LEDGER check and cannot see a column added by hand, a dropped index or a type changed in a console. Renamed to what it does, and a real read-only comparison added beside it — `prisma migrate diff --from-config-datasource --to-schema --exit-code`, which Prisma documents as *"a read-only command that does not write to your datasource(s)"* and which needs no shadow database. Nothing resets or modifies production. Verified locally against a live database before it was wired in: exit 0, *"No difference detected."* The step's shell was then exercised against all three exit codes with a stub, because workflow shell is code that otherwise runs for the first time in production: **0** passes and prints the summary; **2** fails the step with a `::error::` annotation and the diff visible; **1** fails, and the F-12 filter turns a P1001 error reading `postgresql://user:pw@db…` into `postgresql://[redacted]` — without it, an unreachable database would print the production password into the Actions log |
| A33 | Incident #26's shape, on the other evaluator | `MERGED` | found while testing A29. When the GitHub Actions API call throws, `evaluateCronHealth()` never runs and the catch block pushes `cron-staleness` alone — so every other cron id is absent from `results`, and the orphan sweep reads absent as REMOVED. Reproduced against the live reconciler: an open `cron-failures` incident **and the new `cron-evidence-unresolved` gate's own incident** were both queued for closure with *"this check is no longer reported by the monitor"*, because GitHub returned an error. That is precisely how #26 was closed on 2026-09-01 — the monitor going blind and reading its own blindness as an all-clear, which cost a P0 on the ops evaluator and was fixed there and only there. `CRON_DERIVED_CHECK_IDS` plus an `evaluatorFailed` marker now make those checks *unobservable* rather than gone, with a reason that names the cron evaluator instead of `/api/health/ops` so an operator is pointed at the right lever. List/evaluator parity is asserted, as it is for the ops list |

### B. Verification

| # | Gate | Status | Evidence |
|---|---|---|---|
| B1 | Full local suite | `PASSED — LOCAL` | 124 files, **1908 passed**, 41 skipped (the disposable-DB injected-failure suite, which runs in CI); format, lint, types, guards, orphan-perms, reachability all clean; build exit 0 |
| B2 | CI green on the exact merged head | `PASSED — CI` | PR #70 run [33913015937](https://github.com/levantchanturidze/bookpitch/actions/runs/33913015937) — 124 files / **1947 tests, 0 skipped**, 0 vulnerabilities; PR #71 run [33915159529](https://github.com/levantchanturidze/bookpitch/actions/runs/33915159529). Both verified against the exact head SHA before merge (R-07 mitigation). Post-merge CI on the final head: run [33915973985](https://github.com/levantchanturidze/bookpitch/actions/runs/33915973985) |
| B3 | Playwright full matrix | `PASSED — CI` | same runs; locally 265 passed / 3 skipped, and `npm run e2e:check` confirms all 9 required suites executed (268 tests) |
| B4 | Secret scan | `PASSED — CI` | gitleaks green on both PRs; a local scan of a clean `git archive` of HEAD finds only the two fingerprints already accepted in `.gitleaksignore` |
| B5 | Dependency audit | `PASSED — CI` | `found 0 vulnerabilities`. npm's audit endpoint 503'd intermittently on 2026-09-04 and the job was re-run rather than the gate weakened |
| B6 | Migration from scratch + upgrade path | `PASSED — CI` | CI applies all 68 migrations to an empty database and runs `prisma migrate diff --exit-code` against a shadow DB; the upgrade path is migrate run [33863362248](https://github.com/levantchanturidze/bookpitch/actions/runs/33863362248), which applied 68 to the live database with its migration ledger up to date afterwards. The shadow-DB diff is a genuine drift check; the live-database half of this row was `migrate status` and is NOT a drift claim — see A32 |

### C. Production

| # | Gate | Status | Evidence |
|---|---|---|---|
| C1 | Final merge to `main` | `MERGED` | **`c6d59a19e994710607720aab47b950068b611103`** — PRs #70 (`ab045c1`), #71 (`c69abcc`), #72 (`688a96c`, docs), #73 (`c6d59a1`) |
| C2 | Deployment of that exact SHA | `DEPLOYED` | GitHub Deployment **6273536043**, state `success`; both canonical hosts serve `x-bookpitch-release: c6d59a19…`, which equals `origin/main` |
| C3 | Production migrations + strengthened invariants | `PRODUCTION VERIFIED` | run [33928751924](https://github.com/levantchanturidze/bookpitch/actions/runs/33928751924) against **`c6d59a1`** — 68 applied, migration ledger up to date, all 8 invariant checks pass including the exact per-partition policy match and `current_org_id()`. **"No drift" was overstated** and is withdrawn: that run had no schema comparison in it at all. The comparison exists as of A32 and its first production execution is recorded in the checkpoint below |
| C4 | Fresh backup, **actually restored** into a disposable DB | `PRODUCTION VERIFIED` | backup [33928753998](https://github.com/levantchanturidze/bookpitch/actions/runs/33928753998) on `c6d59a1`, artifact `production-backup-33928753998-1` (id 9957780811); restore drill [33929073967](https://github.com/levantchanturidze/bookpitch/actions/runs/33929073967) **restored that artifact into a disposable database** — all 10 restore invariants pass. That backup was a `workflow_dispatch`; the schedule has since delivered one unaided — [33949390174](https://github.com/levantchanturidze/bookpitch/actions/runs/33949390174), `event=schedule`, 2026-09-05T06:17Z — so the nightly job is proven to run without being pressed. The drill still names the dispatched artifact, because that is the one it actually restored |
| C5 | Production smoke + RBAC + cron/outbox/health | `PRODUCTION VERIFIED` | **Natural, first-attempt** scheduled runs on **`c6d59a1`**: monitor [33928608353](https://github.com/levantchanturidze/bookpitch/actions/runs/33928608353) — **25/28 passed, 2 paused, 2 informational, 1 failing**, and the one failure is Sentry; cron [33925555982](https://github.com/levantchanturidze/bookpitch/actions/runs/33925555982). Soak dry run [33929076260](https://github.com/levantchanturidze/bookpitch/actions/runs/33929076260) — 7/7 reads, aliases confirmed on `c6d59a1` |
| C6 | Informational lines do not affect the verdict | `PRODUCTION VERIFIED` | monitor [33928608353](https://github.com/levantchanturidze/bookpitch/actions/runs/33928608353): two INFO lines present, verdict reads `1 production check(s) failing` |
| C7 | Corrected incident reconciliation, against live state | `PRODUCTION VERIFIED` | monitor [33920833148](https://github.com/levantchanturidze/bookpitch/actions/runs/33920833148), unprompted: `incident #44 … reopened — still failing` then `incident #67 closed as a duplicate of #44`. Exactly one open incident for the marker, history restored to #44. Independently repeated by the reverify job (C8) after the second stray-keyword closure |


| A11 | Probe surface reachable past the auth proxy | `PRODUCTION VERIFIED` | found by smoke-testing the deployed app: all three probe routes 307'd to `/signin`, so the whole Sentry flow was unreachable. Fixed in PR #63; verified in production — probe routes 404 (reachable, failing closed), `/api/health/ready` still 307s |

### D. External

| # | Gate | Status | Evidence / exact blocker |
|---|---|---|---|
| D1 | An accessible Sentry workspace | `BLOCKED — MANUAL` | **No authenticated session or configuration is reachable from here** — `sentry.io/organizations/new/` redirects to `/auth/login/`, Vercel Production holds neither DSN, the repository holds no Sentry secret. That is the whole of what the evidence supports: an organisation may exist that nothing here can reach. Signing in needs the operator's credentials; creating one needs their acceptance of Sentry's terms |
| D2 | Sentry DSNs + auth token configured | `BLOCKED — MANUAL` | depends on D1 |
| D3 | Server + browser Sentry receipt | `BLOCKED — MANUAL` | depends on D2 |
| D4 | Designated test mailbox | `BLOCKED — MANUAL` | none nominated |
| D5 | Mailbox UAT | `BLOCKED — MANUAL` | depends on D4 |
| D6 | Legal operator identity + approval | `BLOCKED — MANUAL` | Two separate things. (a) **Data**: `OPERATOR_IDENTITY` in `lib/legal.ts` is all-null — legal name, registration number, postal address, contact. Only the operator has these. (b) **Approval**: `LEGAL_DOCUMENT_STATUS` is `'draft'`, and flipping it asserts that a qualified person reviewed the published privacy notice and terms against the actual processing this system performs. Scope is `docs/legal-review-checklist.md`. Neither is inferable from a green build, and an agent supplying either would be fabricating a representation to data subjects |

| A12 | Sentry lifecycle: closure authority, ordering, real assets, ongoing proof | `MERGED` | `canClose: false` on the config check; starter refuses only unrelated incidents, closes #44 by evidence, re-checks, then starts; probe enable flag removed (its redeploy broke soak identity); map check uses the probe's own assets and fails closed; `observability-continuing` gate + `sentry-reverify.yml` every **4h** (`35 */4 * * *`), against a 14h proof expiry — see A23 |

### E. Soak

| # | Gate | Status | Evidence |
|---|---|---|---|
| E1 | Soak preconditions satisfied | `BLOCKED — MANUAL` | refused by **three** independent gates while D3 is unmet. The canonical observability incident is **#44** (#67 was closed as its duplicate — see A25). `release-verify-and-soak.yml` refuses if production is not serving the named SHA on both canonical hosts; refuses while any **unrelated** `ops-incident` is open — #44 itself is explicitly permitted, because requiring it closed was a deadlock: the incident cannot close without verification and verification would not start while it was open; and `verify-sentry.mjs` writes no receipt without a complete pass, after which the starter closes #44 by evidence and re-checks. The controller then refuses to start without a receipt. **Three, not four**: the earlier count included a probe-enable confirmation that no longer exists — the flag lived in Vercel and changing it redeployed production, which broke the soak's own release identity (A12) |
| E2 | Uninterrupted 24h window on one SHA | `NOT STARTED` | Cannot begin until E1. Everything else it needs is proven: dry run [33867622778](https://github.com/levantchanturidze/bookpitch/actions/runs/33867622778) exercised all 7 evidence reads against production, including the shared heartbeat contract and the retention instant |
| E3 | Natural scheduled evidence inside the window | `NOT STARTED` | Feasibility measured rather than assumed: monitor delivery p99 5.03h against a 6h gap limit, cron p99 3.02h. `retention-in-window` will hold a soak open until the nightly sweep runs inside it — by design, and the reason the window is 24 hours |

---

| C8 | `sentry-reverify.yml` + `sentry-incident.mjs` proven end to end | `PRODUCTION VERIFIED` | first NATURAL run [33925659120](https://github.com/levantchanturidze/bookpitch/actions/runs/33925659120) (`schedule`, attempt 1, `c6d59a1`). Classified `unavailable` — *"could not be attempted … this is not a report that delivery is broken"* — reopened **#44**, skipped the soak refresh, and failed the run so it is visible. Exactly the designed behaviour, in production, on the failure path |

## Resumption checkpoint — 2026-09-05T11:20Z

Everything below is current as of this line. To continue, say only:

> Continue from the Bookpitch finalization ledger and keep working until the
> existing terminal objective is reached.

| | |
|---|---|
| Deployed SHA | **`9cc658265ab2bf24d932b15b55a9840d8cfc7120`** — GitHub Deployment **6280288517** (`success`). Both aliases serve it: `bookpitch.ge` 200 and `www.bookpitch.ge` 308→200, each `x-bookpitch-release: 9cc6582…`, body exactly `{"ok":true}` |
| Evidence SHA | **the same commit.** No delta this round: the D-row and E-row evidence below was gathered after `9cc6582` was deployed, against `9cc6582`. Earlier rounds carried a one-commit documentation regress; this one does not, because the merge that produced the deployment is the merge the evidence describes |
| CI on the merged head | run [33962285998](https://github.com/levantchanturidze/bookpitch/actions/runs/33962285998) on `98284af`, `pull_request`, **attempt 1**, no reruns — `Lint, type-check, test, and build`, `Browser, mobile, and accessibility suite` and `Secret scanning` all success. **2030 tests passed, 0 skipped.** The guard ran as its own workflow, run [33962286005](https://github.com/levantchanturidze/bookpitch/actions/runs/33962286005) |
| Migrations + drift | run [33962683985](https://github.com/levantchanturidze/bookpitch/actions/runs/33962683985), **`event=push`, attempt 1** — natural, not dispatched. 68 migrations, ledger up to date, **and the first schema comparison this project has ever run against production**: `No difference detected.` The same log carries `migrate status`'s `Database schema is up to date!` seconds earlier — two commands, two sentences, two different claims (A32). All 8 invariant checks pass |
| Soak evidence collection | dry run [33962765974](https://github.com/levantchanturidze/bookpitch/actions/runs/33962765974) — 7/7 reads on `9cc6582`; deployment and both alias headers agree with the curl above. **`workflow_dispatch`, therefore DIAGNOSTIC ONLY** — it exercises the changed `runsFor` against real data and must never be cited as natural evidence |
| Branch | `main` at `9cc6582`; no open PRs; working tree clean |
| Open incident | **#44** (canonical). Closed twice by stray PR keywords and reopened twice by the monitor and the reverify job; #67 closed as its duplicate. The guard that refuses a third occurrence now also runs on `edited` (A31) |
| Soak | **never started**; refused by three independent gates while Sentry is unverified (E1) |
| Sentry verifier, natural run on the merged code | run [33964634407](https://github.com/levantchanturidze/bookpitch/actions/runs/33964634407), **`event=schedule`, attempt 1**, head `9cc6582`, 11:55Z. Classified `unavailable`, took **exactly one incident action — `commented on #44`** — and exited non-zero so the run is red. **What this does and does not prove:** it proves the scoped reconciliation still does its legitimate work on the real system, and it is the first natural run of `sentry-incident.mjs` since A28. It does **not** demonstrate the scope guard refusing an unrelated incident, because #44 is currently the only open `ops-incident` — with nothing else open, the unscoped code would also have done nothing else. The refusal itself is proven by the 11 tests in `tests/sentry-incident-scope.test.ts`, all of which go red when the guard is removed |
| Monitor, natural run on the deployed code | run [33969970652](https://github.com/levantchanturidze/bookpitch/actions/runs/33969970652), **`event=schedule`, attempt 1**, head `6d80980`, 13:48Z. **`26/29 checks passed, 2 paused by configuration, 2 informational`**, one FAIL — `production-observability-unconfigured`, "Sentry DSN env vars unset: 2 of 2". The new gate is in the live list and green: `PASS cron-evidence-unresolved — every scheduled run in the window has a readable first-attempt outcome`. Incident handling was correct and narrow: `incident #44 … unchanged — no new comment`, and nothing else touched. A diagnostic dispatch ([33968957215](https://github.com/levantchanturidze/bookpitch/actions/runs/33968957215)) had confirmed the same 20 minutes earlier; it is recorded as diagnostic and was never counted, because a `workflow_dispatch` is not evidence of unattended operation. GitHub took 2.9h to deliver this slot against a nominal 30 minutes — past p90 (2.25h), inside p95 (4.13h), R-08 |
| Next action | supply the three human inputs below. Everything after them is automatic |

### What this round changed, in one line each

A28 scoped incident reconciliation · A29 an unknown outcome blocks instead of
vanishing · A30 exact checkpoint-tip agreement and truncation refused · A31 the
PR guard runs on `edited`, in its own workflow · A32 a drift check that looks at
the schema · A33 a failed cron evaluator is unobservable, not removed.

Two of those were corrections to this round's own work, kept visible rather than
tidied away: the first fix for A31 displaced real CI results with a skipped run
and was reverted (production found it, not a test), and A32 forced the
withdrawal of every "no drift" claim in this document.

## What is checked and what is merely observed

Four claims in this document were stronger than the mechanism behind them. They
are corrected here rather than quietly softened, because each one was cited as
evidence at some point.

**No CI job on this repository is an enforced merge requirement.** Branch
protection and rulesets are unavailable on this plan — the API answers `403
Upgrade to GitHub Pro or make this repository public` for both
`/branches/main/protection` and `/rulesets`. So `Pull request body`,
`Lint, type-check, test, and build`, the browser suite and secret scanning are
all *observed* checks: they run, they go red, and nothing stops a merge on top
of a red one except the person doing it. Where this document said "required CI
job" (A27), read "CI job whose result is visible before merge, and which was
read before merging". R-07 in `docs/phase-15-risk-register.md` carries the
owner's explicit acceptance of this for launch and pilot.

**`prisma migrate status` never proved the absence of schema drift.** It
compares the `_migrations` table with the migrations directory. A column added
by hand, a dropped index, a type changed in a console — none of it is visible to
that command, and the step asserting otherwise was called "Verify no drift after
apply" for months. A32 adds the comparison that does look at the schema.

Every row in this document that cited a `migrate.yml` run for *drift* has been
corrected to say *migration ledger* — the baseline row, B6's live-database half,
and C3. Those runs remain valid evidence for what they actually measured, which
is that the ledger is current and the invariant verifier passes. The **drift**
claim was `NOT VERIFIED` for the whole of Phase 15–17, and the exact missing
evidence was a schema comparison against production, which nothing ran. It runs
now, on every `migrate.yml` invocation, read-only.

Historical phase ledgers (`phase-15-*`, `phase-17-*`, `launch-checklist.md`)
still carry the old wording. They are records of what was believed at the time
and are not restated here; read any "no drift" in them as "migration ledger up
to date".

**The checkpoint chain does not survive an administrator.** The soak state body
and the checkpoint comments are both mutable by anyone with repository write,
and a checkpoint carries no secret of its own — only a digest the controller
produced earlier. An actor with that access can delete every comment after tick
N and restore the tick-N body, leaving a complete, internally consistent,
correctly signed chain. Nothing in the controller can tell that apart from a
soak that genuinely stopped at N. What the chain does buy is mechanical
detection, on the next tick and with no operator vigilance, of: a body rolled
back on its own, a checkpoint deleted or forked or reordered, and a tick that
wrote its body but not its checkpoint (A30). Defending the administrator case
needs an append-only store outside GitHub, which is a larger project than this
soak and is not being started here.

**Missing Sentry configuration proves unavailable access, not an absent
account.** Vercel Production carries `SENTRY_ENVIRONMENT` and
`NEXT_PUBLIC_SENTRY_ENVIRONMENT` and neither DSN, and the repository holds no
Sentry secret. That establishes exactly one thing: this system has no
authenticated route to Sentry. Whether a workspace exists somewhere is not
something the repository can see, and earlier wording that read as "no Sentry
account exists" overstated a read failure. `sentry-reverify.yml` classifies this
as `unavailable` — distinct from `failed` — for the same reason.

### Skipped tests: two different numbers

`npx vitest run` reports **41 skipped** locally and **0 skipped in CI**. Every
one is in `tests/production-invariants.test.ts`, behind
`describe.skipIf(!runnable)`, where `runnable` requires a superuser URL pointing
at a *disposable* host. CI provides one (localhost postgres in a service
container), so the suite executes there; a developer without
`INVARIANT_TEST_DATABASE_URL` gets skips. The skips are a local-environment
artefact, not suppressed coverage — and the suite is the one that proves the
invariant verifier catches a *broken* database, so it must never be quietly
lost.

Playwright's skips are unrelated and are counted separately: 3 of 268, from
per-project conditions in the browser matrix. `npm run e2e:check` asserts that
all 9 required suites executed, which is the check that would catch a suite
silently vanishing. Do not add the two numbers together or cite one for the
other.

## What has never run, and what predates the current SHA

Two honesty notes that the rows above would otherwise imply away.

**One code path has never executed end to end**: `release-verify-and-soak.yml`.
It cannot until D1, because its Sentry step is the gate. Its steps are covered
by tests and the soak controller's evidence collectors have been exercised
against production by a dry run — but the workflow as a whole is `NOT STARTED`,
not `PASSED`.

`sentry-reverify.yml` and `scripts/sentry-incident.mjs` are no longer in that
category: they ran naturally on 2026-09-04 (C8) and behaved correctly on the
failure path. What has not been exercised is their SUCCESS path, which also
requires D1.

**The C-rows name `c6d59a1`, which is no longer the deployed head — and that is
stated, not relabelled.** Migration (33928751924), backup (33928753998), the
restore drill that actually restored that artifact (33929073967), the soak dry
run (33929076260) and three natural first-attempt scheduled runs — cron
33925555982, monitor 33928608353, reverify 33925659120 — were gathered against
`c6d59a1`, after its deployment. Production now serves `9cc6582`.

Two rounds were rejected for exactly this gap, so here is the mechanical
account of what carries over rather than an assurance that it does.

```
$ git diff --name-only c6d59a1 9cc6582 | cut -d/ -f1 | sort -u
.github
docs
scripts
tests

$ git diff --name-only c6d59a1 9cc6582 -- app/ lib/ components/ prisma/ \
      proxy.ts package.json package-lock.json
(no output)
```

The delta is workflows, operational scripts, documentation and tests. **No
application surface and no schema changed at all.** So:

- **Application evidence carries over.** Nothing in the served bundle differs
  between the two commits. The C5 smoke results describe the same application
  that is running now, and this is checkable in one command rather than
  believed.
- **Database evidence carries over.** `prisma/` is untouched; both the C3 run
  and the `9cc6582` run report 68 migrations; and the `9cc6582` run adds the
  schema comparison the C3 run never had — `No difference detected.` A backup
  and a restore drill taken against that schema still describe it.
- **What does NOT carry over is anything about the changed scripts**, which is
  precisely what this round altered. That evidence is fresh and is listed in the
  checkpoint above: CI 33962285998, migrate 33962683985 (`event=push`), the
  deployment and both alias headers, and the diagnostic soak dry run 33962765974.

The regress that ran through the previous rounds — evidence describing a commit
other than the one serving traffic — is closed here by the delta being empty
where it matters, not by asserting the commits are equivalent.

---

## A note on the last row

Merging this file produces a newer commit and a newer deployment than the SHA
recorded beside C2. That is unavoidable and is not a gap: the C3/C4/C5 evidence
was gathered against `408c629`, and the only differences between it and the SHA
serving production are this document, the CI audit retry, and one corrected
error message — none of which change application behaviour. Where a row's
evidence predates the deployed SHA, the row says which SHA it was gathered
against.

The alternative would be to claim verification of a commit nothing has verified,
which is exactly the class of thing this ledger exists to prevent.

---

## Resumption

To continue this work in a new session, say:

> Continue from the Bookpitch finalization ledger and keep working until the
> existing terminal objective is reached.

The next actor should re-observe the baseline above rather than trusting it —
every row is a timestamped observation, and production truth moves.
