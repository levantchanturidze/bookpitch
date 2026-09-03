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

## Baseline — revalidated 2026-09-03T22:30Z

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
| A1 | Soak state machine — recovery, transient vs terminal | `PASSED — LOCAL` | `SOAK_HEALTH_GATES` / `SOAK_PROGRESS_GATES`, every gate classified and asserted to be in exactly one; unreadable identity evidence is now transient, a different release is terminal, an unpinned soak is `blocked`; controlled-clock test proving hour-23 failure cannot become hour-24 success |
| A2 | Authoritative heartbeat contract shared by monitor + soak | `PASSED — LOCAL` | `scripts/heartbeat-contract.mjs`; both consumers import it; 18 tests in `tests/heartbeat-contract.test.ts` incl. omitted/unknown/empty maps, remote threshold inflation and non-numeric ages |
| A3 | Retention success strictly inside the effective window | `PASSED — LOCAL` | new `retention-in-window` soak gate; retention's 30h freshness limit is longer than the 24h window, so `cron-outcomes` alone could certify a window the sweep never ran in |
| A4 | Exact partition-policy verification | `NOT STARTED` | parent policies exact since `dc2a09f`; children checked for RLS + privileges only |
| A5 | Sentry receipt + source-map verification hardening | `NOT STARTED` | |
| A6 | Genuinely single-use browser probe challenge | `NOT STARTED` | current: replayable HMAC in a query string, 5-minute TTL |
| A7 | Automatic Sentry→soak handoff | `NOT STARTED` | receipt is passed by workflow input today, not generated by it |
| A8 | Reminder clock + eligibility contract, shared | `NOT STARTED` | lease moved to DB clock in `414bc02`; contract not yet shared with monitoring |
| A9 | Cron threshold contradiction (1.5h vs 6h) | `PASSED — LOCAL` | measured 191 scheduled runs / 12.5 days: p50 0.44h, p90 2.08h, p99 3.02h, 13.7% of gaps > 1.5h, one > 6h (the billing outage). Split into `cron-delivery-lag` (90m, informational) and `cron-staleness` (6h, gating) |
| A10 | Documentation reconciliation | `NOT STARTED` | |

### B. Verification

| # | Gate | Status | Evidence |
|---|---|---|---|
| B1 | Full local suite | `NOT STARTED` | |
| B2 | CI green on the exact merged head | `NOT STARTED` | |
| B3 | Playwright full matrix | `NOT STARTED` | |
| B4 | Secret scan | `NOT STARTED` | |
| B5 | Dependency audit | `NOT STARTED` | |
| B6 | Migration from scratch + upgrade path | `NOT STARTED` | |

### C. Production

| # | Gate | Status | Evidence |
|---|---|---|---|
| C1 | Final merge to `main` | `NOT STARTED` | |
| C2 | Deployment of that exact SHA | `NOT STARTED` | |
| C3 | Production migrations + strengthened invariants | `NOT STARTED` | |
| C4 | Fresh backup, **actually restored** into a disposable DB | `NOT STARTED` | the 2026-09-03 drill predates the final release |
| C5 | Production smoke + RBAC + cron/outbox/health | `NOT STARTED` | |

### D. External

| # | Gate | Status | Evidence / exact blocker |
|---|---|---|---|
| D1 | Sentry workspace exists | `BLOCKED — MANUAL` | no authenticated session; creating one requires accepting Sentry's terms as the operator |
| D2 | Sentry DSNs + auth token configured | `BLOCKED — MANUAL` | depends on D1 |
| D3 | Server + browser Sentry receipt | `BLOCKED — MANUAL` | depends on D2 |
| D4 | Designated test mailbox | `BLOCKED — MANUAL` | none nominated |
| D5 | Mailbox UAT | `BLOCKED — MANUAL` | depends on D4 |
| D6 | Legal operator identity + approval | `BLOCKED — MANUAL` | `LEGAL_DOCUMENT_STATUS` is `'draft'`, `OPERATOR_IDENTITY` all-null |

### E. Soak

| # | Gate | Status | Evidence |
|---|---|---|---|
| E1 | Soak preconditions satisfied | `BLOCKED — MANUAL` | refused by design while D3 is unmet and #44 is open |
| E2 | Uninterrupted 24h window on one SHA | `NOT STARTED` | |
| E3 | Natural scheduled evidence inside the window | `NOT STARTED` | |

---

## Resumption

To continue this work in a new session, say:

> Continue from the Bookpitch finalization ledger and keep working until the
> existing terminal objective is reached.

The next actor should re-observe the baseline above rather than trusting it —
every row is a timestamped observation, and production truth moves.
