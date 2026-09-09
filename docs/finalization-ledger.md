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
| A34 | An omitted CI failure: the TOTP step-boundary race | `MERGED` | **Run [33962683939](https://github.com/levantchanturidze/bookpitch/actions/runs/33962683939), the `push` build on merge `9cc6582`, failed and was not reported.** I verified the PR head's CI and never looked at the push build on the merge result — the gap that let it pass unnoticed. `tests/platform-break-glass.test.ts:114`, *"expected 400 to be 200"*: the response landed at 11:14:00.045Z after 111ms, so the request began ~66ms before a 30-second TOTP step boundary and was verified after it. **Cause proven, not guessed** — driving the real endpoint at pinned instants: minted 100ms before a boundary and verified 45ms after gives `400 {"error":"invalid or expired TOTP code"}`; the identical request wholly inside one step gives `200`. So this was **test nondeterminism, and the application was correct**: `lib/platform/mfa.ts` passes no `epochTolerance`, so a code is accepted only in the step that minted it. Fixed in the fixture, not the verifier: `tests/helpers/totp.ts` mints only when the step has ≥3s left (vs an observed 111ms request), and both TOTP suites now share it instead of duplicating the racing helper. `tests/totp-step-boundary.test.ts` locks the strictness so the cheap "fix" is blocked — calibrated by applying it: `epochTolerance: [5, 0]` turns 2 tests red, `30` turns 4 red, removing the fixture's wait turns 2 red |
| A35 | A vacuous test of my own, caught and replaced | `MERGED` | The first version of the strictness guard asserted the verifier's source contained no `window:`. That string can never appear — this otplib spells the setting `epochTolerance` — so the check passed unconditionally and only "caught" a perturbation that injected the literal word `window:`. Documentation that compiles, in the file written to prevent exactly that. Replaced with a per-call-site check for the real option, and the behavioural tests were re-calibrated against both settings the library's own docs recommend. Found by perturbing rather than by reading: the first perturbation left every behavioural test green, which is what exposed it |
| A37 | The same hole on the sibling feature | `MERGED` | Swept for the A36 shape — a TTL computed in JS from a database instant, where `Date.now()` could be substituted without any test noticing. One other site matched: `lib/platform/impersonation.ts:84`. Perturbed it: **all 7 tests stayed green**, because `expiresAt` was asserted nowhere in that file; the TTL was simply untested. Impersonation lets a platform admin act as another user, so how long it lasts is a security property (spec §7.1). A skew test now covers it and fails under the perturbation. The other JS-computed expiries were checked and are not this shape: `lib/housekeeping.ts`, `lib/invitations.ts` and `lib/sentry-probe-challenge.ts` evaluate expiry in SQL with `transaction_timestamp()`/`NOW()`, so the database clock is structural and there is no Node clock to substitute |
| A36 | The expiry test proved its property only where the build does not run | `MERGED` | Found while proving A34 had not cost coverage — by perturbation, not by reading. Swapping `dbNowAt.getTime()` for `Date.now()` in `startBreakGlass` left **all 25** break-glass tests green, including `Phase 11 Row 12: expiry uses PostgreSQL time, not Node time`. Row 12 compares `expiresAt` against the DB clock, which passes under either implementation whenever the two clocks agree — and its own comment says it was written against an environment observed to be ≥3h out. So it discriminated on the author's machine and nowhere else. Row 12b now manufactures the skew instead of waiting for it: `Date.now` is pushed 3h forward across both the code mint and the request, so TOTP stays internally consistent, and `expiresAt` must still land on database time. The Node-clock perturbation now fails it. **Coverage re-proven, not asserted** — replay fence loosened `<`→`<=`: 2 red; both app-level concurrency guards removed: 4 red; expiry switched to the Node clock: 1 red. Removing only ONE concurrency guard stays green, correctly: the other catches it first, which is defence in depth rather than a gap |
| A38 | The verifier read a shape the Sentry API does not return | `MERGED` | **Found in production, on the first run that could reach Sentry at all.** With the DSNs finally configured, run [34132603049](https://github.com/levantchanturidze/bookpitch/actions/runs/34132603049) reached level 4 and failed level 5 with `environment is (none), expected production` and `release is [object Object], expected c274409a217a`, on BOTH runtimes. The pipeline was correct: the nonce tag matched, the runtime tag matched, both timestamps were fresh, and **both stacks symbolicated to their own probe source** — every check that was reading the right field passed. `verifyReceipt()` read `event.environment` and `event.release` as plain strings; the endpoint it calls returns **no top-level `environment` at all** (it is a row in `tags`) and `release` as a **Release object**, per [the documented schema](https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/). So a working Sentry was reported broken and no receipt was written — which is precisely what kept the soak from starting. `eventEnvironment()` / `eventRelease()` read both shapes and still fail closed on neither; the failure message now names the value observed, because `[object Object]` told an operator nothing. **The scope question is settled by the same document**: that endpoint lists `project:read` as sufficient, so the review comment suggesting `event:read` was wrong and no permission was expanded |
| A39 | The unit fixture was built from the code's assumption, not the API | `MERGED` | The reason A38 survived 73 passing tests: `tests/sentry-receipt.test.ts` built its event with a top-level `environment` string and a string `release` — the shape `verifyReceipt()` assumed. A fixture that mirrors the code under test can only ever confirm it. There is now a second fixture built from the documented payload, with the old one kept so both shapes stay accepted. **Proven by perturbation, not by reading**: restoring `event.release` → **5 red**; restoring `event.environment` → **3 red**. Before the new tests, both perturbations were the shipping code |
| A40 | A gate that could never go green on the host it runs against | `MERGED` | The same run also failed `SOURCE MAPS NOT PUBLIC` — *"could not establish that 15 map URL(s) are private"* — and this one was not a reading error. Vercel answers **every** `*.map` with a bare `403`, and `classifyMapProbe()` accepted only `404`/`410`, so the check was **unsatisfiable on the host this project deploys to** while the maps genuinely were not served. Measured directly against production, from one client in one moment: the real chunk `200`, its `.map` `403`, a **fabricated** `.map` in the same directory `403`, the same chunk as `.txt` `404`, a nonexistent `.js` `404`, `/foo/bar.js.map` `403`. The refusal is scoped to the extension, not the asset. Resolved with **more evidence, not a lower bar**: `403` becomes its own classification `blocked`, which counts as absence only when a random fabricated path is refused identically *and* a real sibling was served `200` to the same client — the first shows the refusal says nothing about any particular file, the second excludes throttling and an auth wall. Both must be literally `true`. **Six perturbations, all red**: `403 → 'private'` outright (the lazy fix) 1; control always complete 5; sibling requirement dropped 2; truthiness instead of `=== true` 1. `2xx` is still exposure and every other status is still an unknown that fails closed |
| A41 | A CI repair that stopped reaching the file it repairs | `MERGED` | `ci.yml` has a step named **"Point apt at a reachable mirror"**. It rewrote `azure.archive.ubuntu.com` → `archive.ubuntu.com` in `sources.list` and `sources.list.d/*`, and ended `2>/dev/null \|\| true`. Ubuntu 24.04 runners do not keep mirror hostnames there: sources carry `mirror+file:/etc/apt/apt-mirrors.txt` and the hostnames live in **that** file. So the `sed` matched nothing, the `\|\| true` swallowed it, and the step was green on every run while apt went on using the dead mirror. Caught because it finally cost something: CI run [34135292204](https://github.com/levantchanturidze/bookpitch/actions/runs/34135292204) failed on **both** attempts with `Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist` followed by `Get:2 http://azure.archive.ubuntu.com/…`, then 3.5 MB in 2m09s until the step hit its 10-minute bound with 114 MB outstanding — the browser suite never ran, twice, and `e2e:check` correctly refused the missing report rather than reading it as a pass. The mirrorlist is now rewritten too, and the step **asserts** the result instead of hoping for it: any surviving `azure.archive.ubuntu.com` fails the step with an annotation. Workflow shell is code that otherwise runs for the first time in production, so the exact step text was exercised against three simulated runner layouts before merge — mirrorlist present → rewritten, exit 0; no mirrorlist (older image) → exit 0; rewrite prevented → exit 1 with the annotation. **The same shape as A27/A31/A33**: not a wrong control, a control that no longer reaches the thing it controls |
| A42 | The release gate refused a release it had just cleared | `MERGED` | **The last thing standing between a verified release and a soak, and it was a read-after-write race.** Run [34208400168](https://github.com/levantchanturidze/bookpitch/actions/runs/34208400168) — the first run this workflow has ever had — verified Sentry completely (`Highest level proven: 5`, receipt written), closed #44 by evidence at **09:10:36.658**, and then step 10 re-listed open incidents at **09:10:37.797** and was handed `#44` as still open. The authoritative REST record says `closed_at: 2026-09-08T09:10:36Z`; the same listing minutes later returns 0. `gh issue list` is served from GitHub's **search index**, which is eventually consistent, and the step re-read it 1.1s after mutating it. The job refused and `Start the soak` was **skipped** — with a valid receipt on the runner, which the cleanup step then deleted. Because every successful verification closes that incident one step earlier, this gate lost the race as a matter of course: **a third gate that could not go green** (see A40), and the direct reason no soak had ever started. Fixed in `scripts/blocking-incidents.mjs`: the listing only NOMINATES, and each candidate is confirmed against the per-issue endpoint — the strongly-consistent read that already said `closed` while the listing said open. The asymmetry is deliberate and documented: a stale-CLOSED listing is a false refusal and is now removed; a stale-MISSING open incident is a false pass, cannot be fixed by a per-issue read because it was never nominated, and is narrowed by a settle delay. **Confirmation may only ever remove a candidate proven closed — an unreadable one keeps blocking**, the same rule the Sentry verifier applies to an indeterminate outcome. Three perturbations, all red: unreadable treated as closed **2**; `!== 'open'` instead of `=== 'closed'` **1**; no confirmation at all (the original) **5** |

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
| D1 | An accessible Sentry workspace | `PRODUCTION VERIFIED` | **Cleared 2026-09-07 by the operator.** The workspace is reachable from CI: run [34132603049](https://github.com/levantchanturidze/bookpitch/actions/runs/34132603049) authenticated against `bookpitch`/`bookpitch` (EU) and read two events back through the API (level 4 INDEXED). The earlier `BLOCKED` reading is preserved below and was accurate when written — it recorded an unreachable Sentry, which is not the same as an absent one |
| D2 | Sentry DSNs + auth token configured | `PRODUCTION VERIFIED` | Vercel Production carries `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` and both environment variables; GitHub Actions carries the token, org and project. Observed by the monitor rather than asserted: run [34088552353](https://github.com/levantchanturidze/bookpitch/actions/runs/34088552353) 05:53Z `FAIL … DSN env vars unset: 2 of 2`, run [34120437200](https://github.com/levantchanturidze/bookpitch/actions/runs/34120437200) 12:10Z `PASS … both Sentry DSN env vars are present`, **27/29 passed, 2 paused, 2 informational, no failing check**. Presence is not delivery and the check says so itself — that is D3 |
| D3 | Server + browser Sentry receipt | `PRODUCTION VERIFIED` | Proven on the soaked release `9c65845` by run [34211356813](https://github.com/levantchanturidze/bookpitch/actions/runs/34211356813): `Highest level proven: 5 (VERIFIED)`, server event `64c3f513bd294a7f914623128de1f3cb`, browser event `01e943e69a274c53982b1f9a5b6ac5a1`, both stacks resolved to their own probe source, public source maps affirmatively absent and control-confirmed. Then re-proven **four more times unattended** inside the soak window, every one `event=schedule` / `run_attempt=1`, each with a fresh event pair |
| D4 | Designated test mailbox | `BLOCKED — MANUAL` | none nominated |
| D5 | Mailbox UAT | `BLOCKED — MANUAL` | depends on D4 |
| D6 | Legal operator identity + approval | `BLOCKED — MANUAL` | Two separate things. (a) **Data**: `OPERATOR_IDENTITY` in `lib/legal.ts` is all-null — legal name, registration number, postal address, contact. Only the operator has these. (b) **Approval**: `LEGAL_DOCUMENT_STATUS` is `'draft'`, and flipping it asserts that a qualified person reviewed the published privacy notice and terms against the actual processing this system performs. Scope is `docs/legal-review-checklist.md`. Neither is inferable from a green build, and an agent supplying either would be fabricating a representation to data subjects |

| A12 | Sentry lifecycle: closure authority, ordering, real assets, ongoing proof | `MERGED` | `canClose: false` on the config check; starter refuses only unrelated incidents, closes #44 by evidence, re-checks, then starts; probe enable flag removed (its redeploy broke soak identity); map check uses the probe's own assets and fails closed; `observability-continuing` gate + `sentry-reverify.yml` every **4h** (`35 */4 * * *`), against a 14h proof expiry — see A23 |

### E. Soak

> **Scope — read before citing any row in this table.** Every E row below is
> evidence about **`9c658450ce6ee1be3b486baee5b70f940fc2f600` and deployment
> `6324725944`, and about nothing else.** That release was superseded the same
> day: PR #86 landed the dependency advisories as `8572634` and PR #85's merge
> produced `207b555`, so the certified release is no longer the deployed one.
>
> A soak binds to one SHA and one deployment permanently. These rows therefore
> **do not** certify `207b555`, do not certify the merge commit this file lands
> in, and do not carry forward to any later candidate. The final release's soak
> is a **different window, in a different issue**, and its evidence lives there
> rather than being copied back into this table — a post-soak commit would
> change `main` and invalidate the very certification it was recording.


| # | Gate | Status | Evidence |
|---|---|---|---|
| E1 | Soak preconditions satisfied | `PRODUCTION VERIFIED` | All three refusals cleared on 2026-09-08: production served the named SHA on both canonical hosts, no unrelated incident was open, and `verify-sentry.mjs` wrote a receipt after a complete pass. Run [34211356813](https://github.com/levantchanturidze/bookpitch/actions/runs/34211356813), all 12 steps green — the first time this workflow has ever succeeded |
| E2 | Uninterrupted 24h window on one SHA | `SOAK VERIFIED` | **[#84](https://github.com/levantchanturidze/bookpitch/issues/84), closed `2026-09-09T09:51:25Z`: `SOAK SUCCESS — 24 uninterrupted hours on one deployment`, 14/14 gates, 24.1h, 0 restarts, 12 ticks** on release `9c658450ce6ee1be3b486baee5b70f940fc2f600` / deployment 6324725944. Nothing was committed or redeployed during the window — `main`'s newest commit predates the window start by 10 minutes |
| E3 | Natural scheduled evidence inside the window | `SOAK VERIFIED` | 6 natural monitor observations (largest gap **5.4h** against a 6h limit), 1 scheduled backup (34319928259), 15 scheduled cron runs, retention executed `2026-09-09T07:23:49.852Z` **inside** the window, and 4 scheduled first-attempt Sentry re-verifications. No manual dispatch and no rerun was counted anywhere; `evidence-resolved` confirms every scheduled run in the window had a readable first-attempt outcome |

---

| C8 | `sentry-reverify.yml` + `sentry-incident.mjs` proven end to end | `PRODUCTION VERIFIED` | first NATURAL run [33925659120](https://github.com/levantchanturidze/bookpitch/actions/runs/33925659120) (`schedule`, attempt 1, `c6d59a1`). Classified `unavailable` — *"could not be attempted … this is not a report that delivery is broken"* — reopened **#44**, skipped the soak refresh, and failed the run so it is visible. Exactly the designed behaviour, in production, on the failure path |

## Sentry became reachable — 2026-09-07

The D1/D2 blockers cleared: DSNs, an auth token and the org/project slugs were
configured in Vercel Production and in GitHub Actions, and production was
redeployed so the build could inline `NEXT_PUBLIC_SENTRY_DSN`. The monitor
records the transition unaided — run
[34088552353](https://github.com/levantchanturidze/bookpitch/actions/runs/34088552353)
at 05:53Z: `FAIL … Sentry DSN env vars unset: 2 of 2`; run
[34120437200](https://github.com/levantchanturidze/bookpitch/actions/runs/34120437200)
at 12:10Z: `PASS … both Sentry DSN env vars are present`, **27/29 checks passed,
2 paused, 2 informational, no failures at all**.

That is presence, not delivery, and the check says so itself. What it bought was
the first opportunity this project has ever had to run the verifier against a
reachable Sentry — and the verifier failed, twice, for two unrelated reasons
(A38, A40). Both failures were in the *checking*, not in the thing checked:

| Level | Before this round | Why |
|---|---|---|
| 1 CONFIGURED | PASS | both runtimes report a DSN |
| 2 INITIALISED | PASS | both produced a client |
| 3 EMITTED | PASS | both returned an id and drained |
| 4 INDEXED | PASS | both events read back through the API |
| 5 VERIFIED | **FAIL** | read `environment`/`release` off fields the endpoint does not return (A38) |
| — maps not public | **FAIL** | demanded a `404` from a host that answers `403` to every `.map` (A40) |

Nonce, runtime tag, freshness and **symbolication on both runtimes** all passed
throughout. Every check reading a field that exists was already green.

This is the fourth entry in this document's own pattern — the signal looked
broken and the application was fine — and the first where a correct production
was reported as a fault. The cost was not a false green: it was a real green
that could not be recorded, and a soak that could not start.

## RESOLVED — Actions runner allocation: blocked 10:26Z, recovered 20:38Z, 2026-09-09

**Blocked for 10h12m. Recovered.** Between 2026-09-09T10:26:22Z and
2026-09-09T19:24:22Z no job on this repository was ever assigned a runner. The
first successful allocation was observed at **2026-09-09T20:38:57Z**. The record
of the outage is kept below in the tense it was written; the resolution follows.

### The outage, as measured

| Fact | Evidence |
|---|---|
| Last run that got a runner | [34339539456](https://github.com/levantchanturidze/bookpitch/actions/runs/34339539456) at **10:18:48Z** — jobs report 22, 5 and 25 steps |
| First run that did not | [34340209674](https://github.com/levantchanturidze/bookpitch/actions/runs/34340209674) at **10:26:22Z**, the push build on merge `207b555` |
| Shape of the failure | all jobs `conclusion: failure` **~2 seconds** after creation, `steps: []`, `runner_id: 0`, `runner_name: ""` — the jobs never started |
| Annotation, every failed job | `The job was not started because recent account payments have failed or your spending limit needs to be increased.` |
| Actions itself | `enabled: true`, `allowed_actions: all`; all 11 workflows `active`; no runs queued or waiting |
| Runner class | every job in all 11 workflows is `runs-on: ubuntu-latest` — the free standard GitHub-hosted class. **No paid larger-runner SKU is selected anywhere**, so no repository-scoped runner-label change could have fixed this |
| Total runs lost | **15**, across 6 workflows: CI, PR body, Scheduled crons, Production monitor, Production soak, Verify Sentry delivery |

Jobs created, instantly failed, never assigned a runner, with Actions enabled
and nothing queued, is an **account-level entitlement refusal**, not a
repository misconfiguration. It was not confirmable from here in either
direction: `/users/{user}/settings/billing/actions` requires the `user` token
scope, which this token does not carry.

### Resolution — and what the evidence does and does not show

The repository was made **public** at 2026-09-09T10:31:10Z. That is a disclosure
decision, correctly taken by a person and not by an agent.

**Public visibility did not restore allocation at the moment it was applied, and
this ledger will not claim it did.** Fourteen further runs were created after
the repository became public and every one of them failed with `runner_id: 0`
and the identical billing annotation:

```
10:31:29Z  34340673308  PR body                    schedule/pull_request  runner_id=0
10:31:29Z  34340673354  CI                         pull_request           runner_id=0
11:11:19Z  34344220014  Scheduled crons            schedule               runner_id=0
11:46:30Z  34347306440  Production monitor         schedule               runner_id=0
13:05:05Z  34354863087  Verify Sentry delivery     schedule               runner_id=0
13:34:03Z  34357894212  Scheduled crons            schedule               runner_id=0
14:39:12Z  34365025066  Production soak            schedule               runner_id=0
15:07:25Z  34368156204  Scheduled crons            schedule               runner_id=0
16:23:29Z  34376420321  Production monitor         schedule               runner_id=0
17:41:30Z  34384452831  Scheduled crons            schedule               runner_id=0
18:01:27Z  34386481831  Production soak            schedule               runner_id=0
18:35:50Z  34389975329  Scheduled crons            schedule               runner_id=0
19:21:57Z  34394616842  Verify Sentry delivery     schedule               runner_id=0
19:24:22Z  34394859847  Production monitor         schedule               runner_id=0
```

So the recovery boundary is **between 19:24:22Z and 20:38:57Z**, eight to nine
hours *after* the visibility change. Public visibility is a necessary condition
for free standard runners on this plan, and it was not a sufficient one here.
What else changed in that window — an allowance reset, a payment clearing, a
spending limit being raised — is **not observable from this repository**, and
naming one of them would be a guess. The honest statement is: allocation was
refused at 19:24Z, allocation succeeded at 20:38Z, and the cause of the
transition is unattributed.

### Recovery evidence — real runners, real steps

Recovery was proven by re-running the failed jobs of the very run that first hit
the blocker, per `docs/phase-15-actions-restoration-runbook.md` step 1, whose
gate is `steps > 0`:

| | |
|---|---|
| Run | [34340209674](https://github.com/levantchanturidze/bookpitch/actions/runs/34340209674), `event=push`, `head_sha=207b555d2ed0172e9f0069ef98adc50b20ef8410` |
| **Attempt** | **3** — attempts 1 and 2 failed without runners at 10:26Z and 10:28Z. This is a re-run, and it is labelled as one everywhere it is cited |
| Started | 2026-09-09T20:38:57Z |
| Secret scanning | `success`, `runner_id=1000002813`, **5 steps** |
| Lint, type-check, test, and build | `success`, `runner_id=1000002814`, **25 steps** |
| Browser, mobile, and accessibility suite | `success`, `runner_id=1000002815`, **22 steps** |

Non-zero runner ids, non-empty step lists, and three green jobs. The runbook
gate is met.

**A natural scheduled run also recovered**, which the re-run alone would not
prove: [34402573223](https://github.com/levantchanturidze/bookpitch/actions/runs/34402573223)
— `Scheduled crons`, `event=schedule`, `run_attempt=1`, `conclusion=success`,
created 2026-09-09T20:41:37Z. Scheduling is live again, unattended.

### `207b555` is now CI-verified on the merge commit

The previous revision of this section said the push build on `207b555` had never
produced a result and must not be recorded as CI-verified. That is now
superseded by the run above: the push build on the merge commit is **green**, on
real runners, with every job executing its full step list.

The A34 rule that produced that warning — *read the push build after every
merge, the merge commit is a different commit from the PR head* — is unchanged
and still binding. What changed is only that the build finally ran.

**The attempt number stays attached to the claim.** `207b555` is green on
`event=push`, **attempt 3**. It is not a first-attempt result and is never to be
cited as one.

### What is still unverified for the final release

- **`207b555` is not the final release SHA.** Merging this file produces a newer
  commit, a newer deployment, and therefore a new candidate. Every SHA-bound
  gate re-runs against that SHA.
- **`207b555` is NOT soaked, and neither is anything after it.** Soak #84
  certifies `9c65845` and deployment `6324725944` only. It must never be cited
  for a later SHA.
- **Release-bound Sentry verification has not run for this release.**
- The fresh 24-hour soak has not started.

## Public-repository threat model — audited 2026-09-09T20:37Z–20:45Z

The repository became public at 2026-09-09T10:31:10Z. Everything reachable from
it — history, refs, issues, PRs, **Actions logs and Actions artifacts** — is now
world-readable. This audit ran **before** any secret-bearing workflow was
allowed to run again. A previous scan had concluded "only synthetic test
credentials"; that conclusion was **re-derived from scratch here**, not
inherited.

### Credential exposure — full history

Every blob reachable from every ref was scanned (**4,659 named blobs**) for
Postgres URLs with passwords, AWS access-key ids, GitHub tokens, PEM private-key
blocks, real Sentry DSNs, Slack tokens, live Stripe keys and JWTs.

| Pattern | Files | Verdict |
|---|---|---|
| AWS access key id, GitHub token, private-key block, Sentry DSN, Slack token, live Stripe key, JWT | **0** | clean |
| Postgres URL carrying a password | 7 | **all synthetic** |

All 14 distinct occurrences were classified by host **without printing any
password** (F-12 rule): `localhost:5432` and `127.0.0.1:5432` CI service
containers; `db.host`, `db.internal`, `db.example.com`, `db.example.invalid`,
`host:5432` log-redaction fixtures; and one documentation template whose
"credential" is the literal text `postgres.<project-ref>@aws-<n>-<region>.pooler…`.
`db.abcdefgh.supabase.co` in `tests/phase15-db-guard.test.ts` is a fake project
ref. **No real credential is present in any commit, and none has been.** Nothing
required rotation.

Only `.env.example` and `prototype/.env.example` have ever been committed;
`.gitignore` carries `.env*` with an `!.env.example` exception. No `.pem`,
`.key`, `.p12`, `.pfx`, `.jks` or `.ppk` file appears anywhere in history.

### Workflow attack surface

| Check | Result |
|---|---|
| `pull_request_target` | **absent** — and `ci.yml` carries a standing comment forbidding it |
| `workflow_run`, `issue_comment`, `repository_dispatch` | **absent** |
| Secrets reachable from a fork PR | **none.** Every secret-bearing workflow triggers on `schedule`, `workflow_dispatch` or `push` only. The two workflows that do run on `pull_request` are `ci.yml`, whose only secret is `GITHUB_TOKEN` (read-only for forks), and `pr-body.yml`, which uses **no** secrets |
| Script injection from attacker-controlled event fields | **none.** Every `github.event.*` interpolation — `pr-body.yml`'s `PR_TITLE`/`PR_BODY`, `sentry-reverify.yml`'s `GITHUB_EVENT_NAME` — is bound to an **env var**, never inlined into a `run:` string |
| Default token permissions | `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`; every workflow additionally declares an explicit narrow `permissions:` block |
| Production workflows triggerable from a non-main ref | `production-backup.yml` guards `github.ref == 'refs/heads/main'`; `migrate.yml`'s `push` trigger is restricted to `branches: [main]` and to `prisma/**` paths. `workflow_dispatch` requires repository write access, which no fork has |
| Runner class | all 19 job definitions are `runs-on: ubuntu-latest` — free standard GitHub-hosted, no paid SKU |

### Publicly downloadable artifacts

204 artifacts exist and are now world-readable. Two kinds:

- **`gitleaks-results.sarif`** — inspected artifact `10123933389`: `results: 0`,
  208 rules, tool `gitleaks`. A SARIF *with* findings would embed the matched
  snippets; this one has no findings, so no value is disclosed. Every one is
  byte-identical at 6,768 B.
- **`production-backup-*`** — real production database dumps. These are
  **age-encrypted** to the public recipient in `ops/backup-age-recipient.txt`
  (verified to contain an `age1…` **recipient** only — no `AGE-SECRET-KEY`), and
  `production-backup.yml` runs an explicit pre-upload gate that fails the job if
  any staged file lacks the `age-encryption.org` header or is a raw `pg_dump`
  archive.

**This is the one place where the threat model genuinely moved.** Confidentiality
of production dumps previously rested on repository access control *and* age
encryption; it now rests on **age encryption alone**. The encryption is real and
the private key is held only as the `BACKUP_AGE_PRIVATE_KEY` secret, so this is
a defensible posture — but it is a reduction in defence depth and it is recorded
as such rather than reported as "no change".

### Dependency advisories

`npm audit`: **0 vulnerabilities** — info 0, low 0, moderate 0, high 0,
critical 0. Dependabot alerts are disabled repository-side (`403` from the API);
the CI `npm audit --audit-level=high` gate is what covers this, and it fails
closed on a transport outage rather than skipping.

### Verdict

**No confirmed credential exposure. No rotation required. No P0.** Two items
carried forward, both recorded rather than fixed silently: the backup-artifact
defence-depth reduction above, and third-party actions pinned by tag rather than
SHA (`grafana/setup-k6-action@v1`, `gitleaks/gitleaks-action@v2`; all others are
first-party `actions/*`). `sha_pinning_required` is `false`.

## SOAK CERTIFIED — 2026-09-09T09:51:25Z

The first 24-hour production soak this project has ever run **passed**, on its
first attempt, with **zero restarts**.

| | |
|---|---|
| Soak issue | **[#84](https://github.com/levantchanturidze/bookpitch/issues/84)**, closed by the controller at `2026-09-09T09:51:25Z` |
| **Soaked release** | **`9c658450ce6ee1be3b486baee5b70f940fc2f600`** |
| **Soaked deployment** | GitHub Production **6324725944** |
| Effective window | `2026-09-08T09:42:53.822Z` → `2026-09-09T09:51:23Z`, **24.1h, uninterrupted** |
| Restarts | **0** |
| Ticks | 12, checkpoint chain 1→12 intact and monotonic |
| Started by | run [34211356813](https://github.com/levantchanturidze/bookpitch/actions/runs/34211356813) — `release-verify-and-soak.yml`, the only supported entry point |
| Verdict | `SOAK SUCCESS — 24 uninterrupted hours on one deployment`, **14 of 14 gates green** |

### The gates, as the controller reported them

| gate | detail |
|---|---|
| `window-elapsed` | 24.1h of an uninterrupted 24h window |
| `history-continuity` | fetched monitor history reaches back past the window start |
| `monitor-observations` | **6** natural observations (need 6); manual dispatches not counted |
| `monitor-clean` | 0 non-successful observations in the window |
| `evidence-resolved` | every scheduled run in the window has a readable first-attempt outcome |
| `scheduled-backup` | **1** successful scheduled backup inside the window |
| `scheduled-cron` | **15** successful SCHEDULED cron runs (need 4) |
| `observation-gap` | largest gap **5.4h** (limit 6h) |
| `no-incident-in-window` | no incident opened during the window, and none open now |
| `outbox-clean` | 0 dead-lettered outbox rows |
| `cron-outcomes` | every required scheduled job has a fresh successful heartbeat |
| `retention-in-window` | retention succeeded `2026-09-09T07:23:49.852Z`, inside the window |
| `observability-continuing` | fresh events ingested 4.8h before the verdict (limit 14h) |
| `observability` | receipt revalidated: server `542dfa8b8628`, browser `7d17a7d312a3`, a frame resolved to original source |

### Natural evidence, named

- **Monitor** (6, all scheduled, all first-attempt): 34319542102, 34297953956,
  34288262675, 34273171777, 34256710651, 34232146093
- **Backup** (1): 34319928259
- **Cron** (15): 34331247098, 34323615591, 34317094814, 34308708789,
  34298127791, 34292826866, 34288560666, 34282013470, 34276441406, 34263248350,
  34259938359, 34241835006, 34236568301, 34217831045, 34212702574
- **Sentry re-verification** (4, every one `event=schedule` and `run_attempt=1`,
  no reruns and no dispatches):
  [34229256051](https://github.com/levantchanturidze/bookpitch/actions/runs/34229256051),
  [34269337699](https://github.com/levantchanturidze/bookpitch/actions/runs/34269337699),
  [34288119252](https://github.com/levantchanturidze/bookpitch/actions/runs/34288119252),
  [34313189815](https://github.com/levantchanturidze/bookpitch/actions/runs/34313189815).
  Each emitted, indexed and retrieved a **fresh** pair of events in both
  runtimes and reached `Highest level proven: 5 (VERIFIED)`, refreshing the
  proof rather than re-reading the original one.

### Identity held for the whole window

`origin/main`'s newest commit is the merge of PR #83 at **09:32:52Z**, which is
**before** the window opened at 09:42:53Z. Nothing was committed, merged or
redeployed for the whole 24.1 hours; the checkpoint for this soak was
deliberately parked on an unmerged draft branch to keep it that way. Throughout
and at the verdict, both canonical hosts served the pinned SHA and
`/api/health` returned exactly `{"ok":true}`.

### What this certifies, and what it does not

The controller says it itself, and it is worth repeating rather than
paraphrasing away:

> This is the TECHNICAL gate only, and it is the ONLY thing this controller can
> attest to. Releasing additionally requires legal approval and
> designated-mailbox UAT, neither of which is observable from here. **A green
> soak is not a green release.**

### Superseded the day it was certified — by a security patch, not a defect

Hours after this soak certified, `npm audit` went from **0 findings** to **5**
with no change in this repository: the advisories were published overnight.
`next` 16.3.0 fell inside a **CRITICAL** range
([GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36),
[GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)) and
`sharp` 0.35.3 in a HIGH one. Taking the patches bumps a dependency the
application ships, so:

**The soak above certifies `9c65845` and only `9c65845`.** It does not
transfer to the patched release. That release gets its own release-bound Sentry
verification and its own 24-hour window, because the alternative — treating a
soak as a property of "production" rather than of one immutable commit — is
exactly the class of claim this ledger exists to refuse.

Recorded here rather than quietly re-pointed, so that the relationship between
the evidence and the commit it describes stays exact. The certification is not
diminished by being superseded: it proved the release path, the controller and
the gates all work end to end, which is what had never been true before.

### The SHA this document is committed under is NOT the soaked SHA

Merging this file produces a new commit and Vercel deploys it, so the SHA
serving production after this merge is **not** `9c65845`. That is unavoidable
and is not a gap, but it must not be blurred:

- **`9c658450ce6ee1be3b486baee5b70f940fc2f600` is the soaked release.** Every
  number above describes that commit and deployment 6324725944.
- The commit that records this is a later, **documentation-only** change. It
  alters no application surface and no schema, which is checkable in one
  command rather than asserted:
  `git diff --name-only 9c65845 <this merge> -- app/ lib/ components/ prisma/ proxy.ts package.json` returns nothing.
- A future reader must not read "production is soaked" as applying to whatever
  SHA is serving when they look. It applies to `9c65845`. If a later commit
  changes application behaviour, that release is **not** soaked and needs its
  own window.

## Resumption checkpoint — 2026-09-05T21:45Z

Everything below is current as of this line. To continue, say only:

> Continue from the Bookpitch finalization ledger and keep working until the
> existing terminal objective is reached.

| | |
|---|---|
| Deployed SHA | **`77f6226a262d1edc5044893c181060bb01e316e1`** — GitHub Deployment **6283944113** (`success`). Both aliases serve it: `bookpitch.ge` 200 and `www.bookpitch.ge` 308→200, each `x-bookpitch-release: 77f6226…`, body exactly `{"ok":true}` |
| **PUSH build on the merge commit** | run [33981908715](https://github.com/levantchanturidze/bookpitch/actions/runs/33981908715), `event=push`, **attempt 1**, all three jobs success — **129 files, 2044 tests passed, 0 skipped**. Recorded as its own row because skipping this check is what let [33962683939](https://github.com/levantchanturidze/bookpitch/actions/runs/33962683939) sit red and unreported (A34). Verifying the PR head is necessary and not sufficient: the merge commit is a different commit, and nothing on this repository enforces a check on it. **Read this after every merge** |
| CI on the merged PR head | run [33981486417](https://github.com/levantchanturidze/bookpitch/actions/runs/33981486417) on `9ac2f58`, `pull_request`, attempt 1, no reruns — all four green. The guard ran as its own workflow, run [33981486391](https://github.com/levantchanturidze/bookpitch/actions/runs/33981486391) |
| Evidence SHA | `9cc6582` for the migrate/drift and soak-read rows below; `6d80980` for the natural monitor run; **`77f6226`** for CI and the deployment. The delta from `9cc6582` is **docs and tests only** — `git diff --name-only 9cc6582 77f6226 -- app/ lib/ components/ prisma/ proxy.ts package.json` returns nothing — so the application evidence and the schema evidence still describe what is running, checkably rather than by assurance. `migrate.yml` did not re-run, correctly: its path filter matched nothing in this change |
| Migrations + drift | run [33962683985](https://github.com/levantchanturidze/bookpitch/actions/runs/33962683985), **`event=push`, attempt 1** — natural, not dispatched. 68 migrations, ledger up to date, **and the first schema comparison this project has ever run against production**: `No difference detected.` The same log carries `migrate status`'s `Database schema is up to date!` seconds earlier — two commands, two sentences, two different claims (A32). All 8 invariant checks pass |
| Soak evidence collection | dry run [33962765974](https://github.com/levantchanturidze/bookpitch/actions/runs/33962765974) — 7/7 reads on `9cc6582`; deployment and both alias headers agree with the curl above. **`workflow_dispatch`, therefore DIAGNOSTIC ONLY** — it exercises the changed `runsFor` against real data and must never be cited as natural evidence |
| Branch | `main` at `77f6226`; no open PRs; working tree clean |
| Open incident | **#44** (canonical). Closed twice by stray PR keywords and reopened twice by the monitor and the reverify job; #67 closed as its duplicate. The guard that refuses a third occurrence now also runs on `edited` (A31) |
| Soak | **never started**; refused by three independent gates while Sentry is unverified (E1) |
| Sentry verifier, natural run on the merged code | run [33964634407](https://github.com/levantchanturidze/bookpitch/actions/runs/33964634407), **`event=schedule`, attempt 1**, head `9cc6582`, 11:55Z. Classified `unavailable`, took **exactly one incident action — `commented on #44`** — and exited non-zero so the run is red. **What this does and does not prove:** it proves the scoped reconciliation still does its legitimate work on the real system, and it is the first natural run of `sentry-incident.mjs` since A28. It does **not** demonstrate the scope guard refusing an unrelated incident, because #44 is currently the only open `ops-incident` — with nothing else open, the unscoped code would also have done nothing else. The refusal itself is proven by the 11 tests in `tests/sentry-incident-scope.test.ts`, all of which go red when the guard is removed |
| Monitor, natural run on the deployed code | run [33969970652](https://github.com/levantchanturidze/bookpitch/actions/runs/33969970652), **`event=schedule`, attempt 1**, head `6d80980`, 13:48Z. **`26/29 checks passed, 2 paused by configuration, 2 informational`**, one FAIL — `production-observability-unconfigured`, "Sentry DSN env vars unset: 2 of 2". The new gate is in the live list and green: `PASS cron-evidence-unresolved — every scheduled run in the window has a readable first-attempt outcome`. Incident handling was correct and narrow: `incident #44 … unchanged — no new comment`, and nothing else touched. A diagnostic dispatch ([33968957215](https://github.com/levantchanturidze/bookpitch/actions/runs/33968957215)) had confirmed the same 20 minutes earlier; it is recorded as diagnostic and was never counted, because a `workflow_dispatch` is not evidence of unattended operation. GitHub took 2.9h to deliver this slot against a nominal 30 minutes — past p90 (2.25h), inside p95 (4.13h), R-08 |
| Next action | supply the three human inputs below, then **dispatch `release-verify-and-soak.yml` explicitly** — see the correction under *What is checked and what is merely observed* |

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

**The soak does not start itself when a DSN appears.** Earlier wording here and
in session reports said the release path "unblocks the moment a DSN exists" and
that everything after the human inputs "is automatic". That overstates it.
`release-verify-and-soak.yml` is `workflow_dispatch`-only: adding Vercel
environment variables changes no workflow trigger, and nothing in this
repository watches for a DSN appearing. What the DSN removes is a *refusal*, not
the need for a decision. The full sequence is: configure the DSNs → redeploy so
the build picks up `NEXT_PUBLIC_SENTRY_DSN` (it is inlined at build time) →
dispatch `release-verify-and-soak.yml` with the release SHA → it verifies
Sentry, closes #44 by evidence, re-checks, and only then starts the soak, which
`soak.yml` then ticks every 30 minutes. Steps two and three are deliberate acts.

**A push build was not read, and it had failed.** CI run 33962683939, on merge
commit `9cc6582`, went red on a TOTP step-boundary race (A34) and no one looked:
the PR head's checks were verified before merging and the push build on the
merge result was not. Verifying the head is necessary and is not sufficient —
the merge commit is a different commit, and on this repository nothing enforces
a check on it. Read the push build after every merge.

### Four defects, zero application changes

The 2026-09-05 continuation round (A34–A37) changed no application code at all.
`git diff --name-only 9cc6582 77f6226` touches only `docs/` and `tests/`.

That is worth stating plainly, because it is the opposite of the usual finding.
In each case the application was correct and the test was wrong:

| | The test said | What was true |
|---|---|---|
| A34 | correct password + TOTP returns 200 | it did, unless the request crossed a 30s step boundary — the code really had expired |
| A35 | the verifier's window is not widened | it asserted a string (`window:`) that cannot appear in this library |
| A36 | expiry uses PostgreSQL time, not Node time | it passed either way unless the machine had clock skew |
| A37 | — | the impersonation TTL was asserted nowhere |

Three of the four were found by **perturbing the application and watching the
tests**, not by reading them. A35 is the argument for that method: it was
written in this round, by the same hand, specifically to prevent this class of
mistake, and it was an instance of it. Reading a test tells you what it claims;
only breaking the code tells you what it checks.

Two of the perturbations produced **zero** failures before the fixes:

```
break-glass expiry, DB clock -> Node clock    before: 0 red   after: 1 red
impersonation TTL, DB clock -> Node clock     before: 0 red   after: 1 red
```

"Preserving existing coverage" would have preserved nothing there.

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
