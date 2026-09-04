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

## Baseline — revalidated 2026-09-04T13:36Z (superseded by the evidence below)

Observed directly, not carried over from any earlier summary.

| Fact | Value | How observed |
|---|---|---|
| `origin/main` | `6452f3da7a89f996417240ffff61d7522e680f7a` | `git rev-parse origin/main` |
| Local tree | clean, `main`, 0 ahead / 0 behind | `git status`, `git rev-list --left-right` |
| Open PRs | none | `gh pr list --state open` |
| Open incidents | **#44** only (Sentry). #60 (cron staleness) closed itself on recovery | `gh issue list --label ops-incident` |
| Production deployment | id **6252458484**, sha `6452f3d`, state `success` | GitHub Deployments API |
| Aliases | `bookpitch.ge` 200, `www.bookpitch.ge` 308→200, both `x-bookpitch-release: 6452f3d…` | `curl -sI` |
| Health body | exactly `{"ok":true}` | `curl` |
| Migrations | 67 applied, none pending, no drift | run [33801704929](https://github.com/levantchanturidze/bookpitch/actions/runs/33801704929) |
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
| A10 | Documentation reconciliation | `MERGED` | operations.md env table repaired (3 GitHub rows were orphaned below the Sentry prose and rendered as text) + the 3 Sentry build/API vars and `SENTRY_PROBE_ENABLED` added; `pg_restore --list` no longer described as "restorable"; superseded banners on the phase-17 Sentry instructions; release-state records this round and stops claiming "everything automatable is done" unqualified |

| A13 | Receipt survives its own lifecycle | `MERGED` | `receiptDigest()` binds `notBefore` AND `verifiedAt`; seeding dropped one and overwrote the other while keeping the digest, so the first revalidation hashed a different document. Both preserved verbatim; the bound is read through `soakFreshnessBound()` |
| A14 | Informational results excluded from the process verdict | `MERGED` | one `summariseResults()` for the summary, step summary and exit code; a complement test applies the OLD predicate to prove the new tests discriminate |
| A15 | Re-runs are not natural evidence | `MERGED` | `scripts/run-evidence.mjs`: scheduled AND `run_attempt === 1`; ordering on the immutable `created_at`; re-runs reported on their own INFO line |
| A16 | All verdict-relevant soak state signed | `MERGED` | `soakStateDigest` over 8 fields plus the receipt digest; replay anchored to the soak issue's creation time |
| A17 | Truncated organizations counted as unreached work | `MERGED` | measured in the fixture DB: 192 organizations dropped, HTTP 200, healthy heartbeat |

| A18 | A wrongly closed incident reopens rather than duplicating | `MERGED` | found in production: a PR body reading "the verifier closes #44 by evidence" was parsed by GitHub as a closing keyword and closed the incident while its check was still failing. `canClose: false` governs this monitor, not GitHub's automation. A still-failing check now reopens its own issue, keeping the history on one number |

### B. Verification

| # | Gate | Status | Evidence |
|---|---|---|---|
| B1 | Full local suite | `PASSED — LOCAL` | 124 files, **1828 passed**, 41 skipped (the disposable-DB injected-failure suite, which runs in CI); lint 0 errors; types clean; build exit 0; prettier clean |
| B2 | CI green on the exact merged head | `PASSED — CI` | PR #66 run [33885769448](https://github.com/levantchanturidze/bookpitch/actions/runs/33885769448) — 124 files / **1869 tests, 0 skipped**, 0 vulnerabilities. Verified against the exact head SHA before merge (R-07 mitigation) |
| B3 | Playwright full matrix | `PASSED — CI` | same runs, `Browser, mobile, and accessibility suite` green; all 9 required suites |
| B4 | Secret scan | `PASSED — CI` | gitleaks green on both PRs; a local scan of a clean `git archive` of HEAD finds only the two fingerprints already accepted in `.gitleaksignore` |
| B5 | Dependency audit | `PASSED — CI` | `found 0 vulnerabilities`. npm's audit endpoint 503'd intermittently on 2026-09-04 and the job was re-run rather than the gate weakened |
| B6 | Migration from scratch + upgrade path | `PASSED — CI` | CI applies all 68 migrations to an empty database and runs `prisma migrate diff --exit-code` against a shadow DB; the upgrade path is migrate run [33863362248](https://github.com/levantchanturidze/bookpitch/actions/runs/33863362248), which applied 68 to the live database with no drift |

### C. Production

| # | Gate | Status | Evidence |
|---|---|---|---|
| C1 | Final merge to `main` | `MERGED` | **`bd42a471ae7edad3d1382a8237d2eb141adf0c27`** (PR #66) |
| C2 | Deployment of that exact SHA | `DEPLOYED` | GitHub Deployment **6266990877**, state `success`; both canonical hosts serve `x-bookpitch-release: bd42a471…`, which equals `origin/main` |
| C3 | Production migrations + strengthened invariants | `PRODUCTION VERIFIED` | run [33887082471](https://github.com/levantchanturidze/bookpitch/actions/runs/33887082471) against `bd42a47` — 68 applied, no drift; all seven checks pass, including the exact per-partition policy match and `current_org_id()` |
| C4 | Fresh backup, **actually restored** into a disposable DB | `PRODUCTION VERIFIED` | taken AFTER the final deployment: backup [33887076578](https://github.com/levantchanturidze/bookpitch/actions/runs/33887076578), artifact `production-backup-33887076578-1` (id 9942303278); restore drill [33887514369](https://github.com/levantchanturidze/bookpitch/actions/runs/33887514369) **restored it into a disposable database** — 68 migrations all finished, 28 tables, 10 organizations, append-only triggers present and `UPDATE` rejected, 13 partitions, **34 RLS policies** |
| C5 | Production smoke + RBAC + cron/outbox/health | `PRODUCTION VERIFIED` | **Natural scheduled** monitor run [33893547883](https://github.com/levantchanturidze/bookpitch/actions/runs/33893547883) against `bd42a47` — **25/28 passed, 2 paused, 2 informational**, sole failure Sentry (#44). Soak dry run [33887810194](https://github.com/levantchanturidze/bookpitch/actions/runs/33887810194) — 7/7 evidence reads, `unhealthyJobs=[]`, `retentionSuccessAt=2026-09-04T07:14:45Z` (an absolute DB instant, not a reconstructed age). Probe surface: token and probe answer **401** without a bearer, `/probe/sentry` **404** without a challenge, `/api/health/ready` and `/scheduler` still **307** to `/signin` |

**That natural run is also the live proof of the informational-verdict fix.**
`cron-delivery-lag` tripped at 1.6h — the exact condition that previously made
the workflow exit non-zero and reset a soak — and the run printed:

```
note: cron-delivery-lag is reporting, but is informational and does not fail this run
1 production check(s) failing:
```

One failing check, and it is Sentry. Before this round that would have been two,
and a soak would have restarted for a delivery gap nobody can act on.

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

| A12 | Sentry lifecycle: closure authority, ordering, real assets, ongoing proof | `MERGED` | `canClose: false` on the config check; starter refuses only unrelated incidents, closes #44 by evidence, re-checks, then starts; probe enable flag removed (its redeploy broke soak identity); map check uses the probe's own assets and fails closed; `observability-continuing` gate + `sentry-reverify.yml` every 6h |

### E. Soak

| # | Gate | Status | Evidence |
|---|---|---|---|
| E1 | Soak preconditions satisfied | `BLOCKED — MANUAL` | refused by **four** independent gates while D3 is unmet (the observability incident is now **#67**, reopened/re-raised after #44 was closed by a stray PR keyword): `release-verify-and-soak.yml` refuses without a probe-enabled confirmation, refuses if production is not serving the named SHA on both hosts, refuses while any `ops-incident` is open (#44 is), and `verify-sentry.mjs` writes no receipt without a complete pass. The controller then refuses to start without one |
| E2 | Uninterrupted 24h window on one SHA | `NOT STARTED` | Cannot begin until E1. Everything else it needs is proven: dry run [33867622778](https://github.com/levantchanturidze/bookpitch/actions/runs/33867622778) exercised all 7 evidence reads against production, including the shared heartbeat contract and the retention instant |
| E3 | Natural scheduled evidence inside the window | `NOT STARTED` | Feasibility measured rather than assumed: monitor delivery p99 5.03h against a 6h gap limit, cron p99 3.02h. `retention-in-window` will hold a soak open until the nightly sweep runs inside it — by design, and the reason the window is 24 hours |

---

## What has never run, and what predates the current SHA

Two honesty notes that the rows above would otherwise imply away.

**`release-verify-and-soak.yml` has never completed end to end.** It has never
been dispatched, because its Sentry step cannot pass without D1. Its individual
steps are covered by tests, and the soak controller's evidence collectors have
been exercised against production by a dry run — but the workflow as a whole is
`NOT STARTED`, not `PASSED`. The same is true of `sentry-reverify.yml`.

**The production evidence in C3–C5 predates the current head.** It was gathered
against `408c629` / `b2bb4c0`. Every row names the SHA it was gathered against;
where the current head differs, the difference is what that row does not cover.
A fresh backup, restore drill, natural monitor run and soak dry run against the
final SHA are the last items in the sequence, and they follow the final merge
rather than preceding it.

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
