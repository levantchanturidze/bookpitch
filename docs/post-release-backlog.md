# Post-release backlog: round record and release plan

**Status on 2026-10-18: 14 pull requests open (#111–#124), none merged. New release
gate NOT STARTED.** Production is the certified release `fdf6559`, unchanged.

The decisions only a person can make before launch are in
`docs/launch-human-decisions.md`. Current production state lives in
`docs/release-state.md`, which this work did not change.

> **Merging any of these is a production change.** Vercel deploys every push to
> `main`, so every merge gives production a new deployment id, moving it off the
> certified deployment. Two merges also run `migrate.yml` against production:
> #112, which applies its migration and changes the invariant verifier, and
> #122, which changes the verifier. The next release gate decides when.

## 1. Baseline (re-observed 2026-10-18, read-only)

| Fact | Observed |
|---|---|
| `origin/main` | `fdf6559891788a41b545ae5823de89b5f3a1689f` |
| Production deployment | `6769046032`, sha `fdf6559` (created 2026-09-30T20:09:21Z) |
| Certification | soak #110, closed 2026-10-03, certifying `fdf6559` / `6769046032`. Untouched |
| Production monitor | red on exactly one check, `reminders-missed NOT VERIFIED` (no appointment was owed a reminder in 48 h). Latest scheduled run `39146474389`, 2026-10-18T16:45Z |
| Open `ops-incident` | #90 only (reopened 2026-10-05 by the empty window; see #119) |
| Sentry re-verification | scheduled run `39128538815`, 2026-10-18T12:44Z: success |
| Backups | scheduled, daily, green (latest `39104414867`, 2026-10-18T06:32Z). Restore drill last green 2026-10-04 |
| Branch protection on `main` | none (`404 Branch not protected`) |
| `main`'s own test suite, today | 148 files, 2259 passed, 47 skipped, exit 0 (local). The build passes |

## 2. The pull requests

All target `main` (base `fdf6559`). **Every branch contains #121**, merged in on
2026-10-18 so that its own CI runs the code checks (§3). **#117 contains #113.**

| PR | Branch | Head | What it does |
|---|---|---|---|
| #121 | `ci/independent-dependency-audit` | `f9d890b` | CI runs the dependency audit as its own job, so its failure no longer stops format, lint, types, migrations, tests and build from running. The audit is not weakened |
| #111 | `chore/deps-audit-2026-10-17` | `62092a6` | `sharp` 0.35.5 (runtime) and `source-map-js` 1.2.2, lockfile only |
| #112 | `fix/cross-location-double-booking` | `d124cfd` | **The only migration.** One practitioner cannot be booked in two places across their staff rows. Check 9, a tested read-only preflight, and a recovery table |
| #113 | `fix/reminder-settings-rbac` | `5846366` | Reminder templates and lead time need `org.settings.update:org`; the lead time is audited, with a row lock so `previous` is right |
| #114 | `feat/waitlist-audit-trail` | `6b60d6e` | Waitlist audit trail, including entries removed with a customer. Savepoint fix for a silent rollback. Explicit org filters |
| #115 | `fix/verification-email-supersession` | `cf49831` | A resend withdraws the queued old verification email; withdrawn mail is `cancelled`, not `dead` |
| #116 | `fix/scoped-location-switcher` | `12b04d4` | The location switcher offers only reachable locations |
| #117 | `fix/server-action-typed-denials` | `461857f` | Refused Server Actions return a typed result, not a 500. **Contains #113**, reconciled |
| #118 | `fix/scheduler-resilience` | `30ae8cc` | More schedule lines (GitHub throttles per line), plus tests proving overlapping runs are safe |
| #119 | `fix/monitor-verification-semantics` | `9a60698` | An empty reminder window is `NOT VERIFIED`, not a failure. Does not end #90 |
| #120 | `docs/post-release-backlog` | this PR | This record, the launch checklist, and the legal-checklist item of 2026-10-18 |
| #122 | `fix/verify-trigger-states` | `eb44997` | The verifier refuses replica-only tenant-isolation triggers (checks 8b/8c) and replica-mode role or database defaults (2b) |
| #123 | `test/teardown-failures-visible` | `9ad41b6` | Test teardowns no longer swallow DB errors inside transactions; a static check keeps it that way |
| #124 | `docs/migration-rollback-inventory` | `9e6b68b` | Rollback rules and inventory for the 74 applied migrations, plus a test that holds new migrations to a complete rollback |

## 3. CI status, per pull request (from the run records)

Every head below: **quality jobs ran and passed; the security audit failed.**
Nothing is labelled "fully validated", because the dependency audit is red.

| PR | CI run | `Lint, type-check, test, and build` | Tests in CI | Browser suite | Secret scan | Dependency audit |
|---|---|---|---|---|---|---|
| #121 | `39148260438` | pass | 148 files, 2313 | pass | pass | **fail** |
| #111 | `39152079912` | pass | 148 files, 2313 | pass | pass | **fail** |
| #112 | `39152084291` | pass | 149 files, 2355 | pass | pass | **fail** |
| #113 | `39152087416` | pass | 149 files, 2334 | pass | pass | **fail** |
| #114 | `39152090273` | pass | 149 files, 2331 | pass | pass | **fail** |
| #115 | `39152095477` | pass | 149 files, 2326 | pass | pass | **fail** |
| #116 | `39152097386` | pass | 149 files, 2337 | pass | pass | **fail** |
| #117 | `39152100259` | pass | 151 files, 2363 | pass | pass | **fail** |
| #118 | `39152102456` | pass | 149 files, 2321 | pass | pass | **fail** |
| #119 | `39152106466` | pass | 148 files, 2321 | pass | pass | **fail** |
| #122 | `39152109306` | pass | 148 files, 2319 | pass | pass | **fail** |
| #123 | `39152113623` | pass | 149 files, 2320 | pass | pass | **fail** |
| #124 | `39152116917` | pass | 149 files, 2319 | pass | pass | **fail** |

All `pull_request` events, attempt 1. "Tests in CI" is CI's own vitest total.
Nothing is skipped in CI: CI has the superuser URL, so the invariants suite runs
there. Each total equals the local count plus the invariants suite. The audit
fails on `braces` alone (§6). #120's own run is in its CI evidence comment.

**Before 2026-10-18, no PR had a CI result for its code at all.** The audit step
ran inside the quality job and stopped it at step 6.

## 4. Integration rehearsal on the actual heads (2026-10-18)

All fourteen branches were merged into a throwaway local branch built from
`origin/main` (never pushed): #121 `f9d890b`, #111 `62092a6`, #119 `9a60698`,
#118 `30ae8cc`, #113 `5846366`, #122 `eb44997`, #112 `d124cfd`, #114 `6b60d6e`,
#115 `cf49831`, #116 `12b04d4`, #117 `461857f`, #123 `9ad41b6`, #124 `9e6b68b`,
#120 `07625f0`. **There was no textual conflict.** The one real conflict, #113 with
#117, is resolved inside #117's branch.

| Check, combined tree | Result |
|---|---|
| `npm ci` from the combined lockfile | exit 0 (`sharp` 0.35.5, `source-map-js` 1.2.2) |
| `format:check` / `lint` / `tsc --noEmit` | exit 0 / 0 (0 errors, `main`'s 11 warnings) / 0 |
| `npm run test`, run 1 | **1 failure**: `tests/platform-impersonation.test.ts` "end marks the session ended", a 30 s timeout (69.6 s). The run took 188 s while an `npm ci` ran beside it. No PR touches that file, and alone it passes 8/8 in 1 s |
| `npm run test`, run 2, quiet, with a lock-wait watcher | **exit 0. 158 files, 2432 passed, 63 skipped**, 77 s. **0** lock-wait samples. The skips are the invariants suite's database cases, which need a superuser URL; they ran separately, below |
| Invariants suite, fresh seeded UTC database, 75 migrations | **64/64** (`main` 48, #122 +6, #112 +10) |
| `next build` | exit 0 (the same commit, built in the browser-suite worktree) |
| Browser suite (Playwright 1.61.1, all 9 projects, disposable database, CI's environment) | **266 passed, 3 skipped (269)**; `e2e:check`: all 9 required suites executed |
| #124's rollback rule, live on #112's real migration | removing its ledger step turns the test red |
| Dependency audit, combined tree (a separate gate) | **5 high**, the single `braces` chain; nothing else |

After each run, #112's migration was rolled back out of the local databases, ledger
row included, and verified at 74 migrations with zero #112 objects.

**What changed since 2026-10-17's rehearsal.** That one found 12 failures when
#113 met #116 and #117, and the fix existed only as a diff in this document.
Now it is in the branches:
- #113's page test uses the real location loader, so #116's rename cannot break
  it: 45/45 combined;
- #117 contains #113, with the conflict resolved and the seven refusal
  assertions moved to the typed contract.

## 5. Findings (cumulative)

| # | Finding | Status |
|---|---|---|
| F-1 | The CI audit failed on every PR and **hid every code check** behind it. `braces` <= 3.0.3 (GHSA-vfj7-8cjw-p6xm) has no patched release | **Fixed in #121** (the audit is its own job). The advisory is unresolved; see §6 |
| F-2 | `sharp` < 0.35.5 (GHSA-wq5f-xc86-pv6w) is in the **deployed runtime**: 45 of 130 server file traces name it | Fixed in #111 |
| F-3 | Superseded mail was recorded `dead`: false dead-letter incidents, and the runbook retry would resend stale reset links | Fixed in #115 |
| F-4 | A DB error swallowed inside an interactive transaction rolls the whole transaction back while the callback returns. A cancellation was erased behind a 200 | Fixed in #114 (savepoint). The only production instance |
| F-5 | UI cancellation never notifies the waitlist; only the API route does | Documented, product decision (§8) |
| F-6 | GitHub throttles each `cron:` line to about 5 runs a day | #118 |
| F-7 | The reminders tick has gone 9.9 h between runs, against `MIN_REMINDER_LEAD_HOURS = 8` | Mitigated by #118. Gate query; owner decision |
| F-8 | `safeAction` swallowed `redirect()` / `notFound()` (latent) | Fixed in #117 |
| F-9 | Billing's server-component forms discarded action results | Fixed in #117 |
| F-10 | Test teardowns swallowed DB errors inside transactions: 36 sites, 31 inside one. Measured: the callback returns and the earlier write is lost | **Fixed in #123**, with a static check |
| F-11 | 37 of 74 migrations write a rollback, and **none** deletes its ledger row; `resolve --rolled-back` is refused for a succeeded migration (P3012) | **#124**: inventory, rules, and a test for new migrations |
| F-12 | #90 was reopened by an empty window, with no evidence | #119; #90 closes only on real evidence |
| F-13 | #113 × #116 and #113 × #117 conflict without a textual conflict | **Resolved in the branches** (§4) |
| F-14 | Merging #112 applies its migration in production | Preflight is a tested script, owner-run before merge (§7) |
| F-15 | **Codex on #112:** check 9 counted a replica-only trigger (`tgenabled 'R'`) as enabled | Fixed in #112 |
| F-16 | **The same gap on `main`:** checks 8b/8c (the C7 tenant-isolation triggers) accept a replica-only trigger, and nothing checks for a `session_replication_role = replica` default, which turns off every ordinary trigger and foreign key | **Fixed in #122** |
| F-17 | **Codex on #113:** concurrent lead-time saves could record a stale `previous` | Fixed in #113 (row lock) |
| F-18 | **Codex on #114:** a customer deletion cascaded waitlist entries away unaudited | Fixed in #114 (lock, read, delete, audit) |
| F-19 | Every waitlist query relied on RLS alone, against CLAUDE.md invariant 1 (pre-existing on `main`) | Fixed in #114 (explicit `organization_id`) |
| F-20 | The housekeeping advisory lock, and overlapping reminder ticks, had no test, while #118 makes overlap routine | Tested in #118 |
| F-21 | **Erasure leaves more than `/privacy` says:** waitlist notes, reminder delivery records (address, a body containing the name), and the erased name itself in the append-only audit log (`previousName`) and a notification | **Documented for legal review**, not changed: a legal decision (`docs/legal-review-checklist.md`) |

## 6. Security posture

| Advisory | Path | Reaches production? | Status |
|---|---|---|---|
| GHSA-wq5f-xc86-pv6w, `sharp` < 0.35.5 | `next` → `sharp` | **yes**: the image optimizer, in 45 server traces | fixed in #111 |
| GHSA-68fv-2mgg-jv7q, `source-map-js` < 1.2.2 | postcss, tailwind, jsdom | build and test only | fixed in #111 |
| **GHSA-vfj7-8cjw-p6xm**, `braces` <= 3.0.3: stack-exhaustion DoS from deeply nested patterns | `eslint-config-next@16.2.11` (devDependency) → `@next/eslint-plugin-next` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces` | **no**: lint time only, expanding the plugin's own patterns; no server trace names it | **unresolved.** No patched release exists. `@next/eslint-plugin-next@16.4.2` still pins `fast-glob@3.3.1`, and every `micromatch@4` depends on `braces`. `npm audit fix --force` would downgrade `eslint-config-next` to 14.2.35. **Owner decision** (§8) |

No exception, allowlist or threshold change is configured. The audit job stays red
while the advisory is open, under its own name.

## 7. Release plan for the next gate

### Merge order

| Step | PR | Notes |
|---|---|---|
| 1 | #121 | First: from here on, every merge commit's push CI checks the code |
| 2 | #111 | Runtime dependency (`sharp`). Smoke: `/api/health` → `{"ok":true}` |
| 3 | #119 | Before or with #118 |
| 4 | #118 | Changes live schedules. Merge before any soak |
| 5 | #113 | **Before #117** |
| 6 | #122 | **The merge runs the verifier against production** (read-only). Expected: pass |
| 7 | #112 | **The merge is the migration.** Run `scripts/practitioner-double-booking-preflight.sql` against production first (owner, read-only; expected `0 \| 0 \| 0 \| PASS`). After merge, `migrate.yml` must show the migration applied, no drift, and check 9 ok. Recovery: `docs/practitioner-double-booking.md` |
| 8 | #114 | — |
| 9 | #115 | The first housekeeping run deletes `cancelled` rows older than 30 days |
| 10 | #116 | — |
| 11 | #117 | Contains #113; after step 5, its diff is its own changes and the reconciliation |
| 12 | #123 | Test-only |
| 13 | #124 | Docs, a script, a test. Its rule then applies to every new migration |
| 14 | #120 | Docs |

The rehearsal proves the final combined tree. Before each merge, read that
head's own CI run on the then-current `main`. After each merge, read the push
run on the merge commit (attempt 1, from the unfiltered listing).

### Branch protection (owner setting; not changed here)

With #121 merged, these can go green and are worth requiring: `Lint, type-check,
test, and build`, `Browser, mobile, and accessibility suite`, `Secret scanning`,
`Pull request body`. Do **not** require `Dependency audit (high and critical)`
until the `braces` decision is made, or nothing can merge.

### Production UAT gates

Synthetic UAT organisation and its fixtures only. Never a customer, and never a
production membership changed for a test. Pair every crafted refusal with a
crafted allowed call.

| PR | Gate |
|---|---|
| #112 | Link a provider at two locations. Book A at 10:00; B at 10:30 → 409; B at 11:00 → OK. The picker at B hides 10:00 |
| #113 | The provider and front desk see settings read-only, and a crafted save is refused. The owner's lead-time change appears in `/audit` with `previous` |
| #114 | Waitlist add and remove audited. A cancellation through the API audits a `notified` row per entry. Deleting a UAT customer with an entry audits that entry |
| #115 | **Blocked until a test mailbox is designated.** Then one working email per resend, and `outbox-dead-letters` stays green |
| #116 | FD-A sees only location A; a hand-set cookie for B still shows A; FD-0 sees "No location assigned" |
| #117 | A crafted refused action answers 200 with `{ ok: false, code }` and changes nothing. Card payment still reaches the gateway |
| #118 | Natural runs over 7 days: monitor ≥ 15/day, max gap < 5 h, < 5% of 24 h windows with a gap over 6 h, reminders and housekeeping union max gap < 6 h, no cancelled scheduled monitor run. If it fails, **do not raise thresholds** (§8) |
| #119 | The monitor stops failing on an empty window; #90 stays open |
| #122 | The merge run's verifier passes |

### Before a soak can certify the new release

- Every merge done; the final SHA served on both canonical hosts.
- #118's delivery criteria met on natural runs.
- **#90 closed by the canonical automation** on a natural run that measured a
  real owed-and-delivered appointment. Never closed by hand. No other
  `ops-incident` open.
- Sentry verified by `release-verify-and-soak.yml`.
- The lead-time query answered: `SELECT count(*) FROM organizations WHERE
  reminder_lead_hours < 10;` (read-only, no PII), and the decision recorded.
- `fdf6559`'s certification (#110) remains the record for `fdf6559` only.

## 8. Release gates

| Gate | Status | Evidence, or what is missing |
|---|---|---|
| Code checks in CI, every PR head | **PASS** | §3 |
| Dependency audit | **FAIL** | `braces`; owner decision |
| Combined tree: unit, integration, invariants, build, browser | **PASS** (local) | §4 |
| Migration #112, local validation | **PASS** | applies from the true predecessor; abort leaves nothing; rollback byte-identical; preflight and check 9 tested |
| Migration #112, production preflight | **NOT RUN** | owner-run, read-only, before merge |
| Incident #90 | **BLOCKED** | needs #119 deployed, then a real owed-and-delivered reminder on a natural run |
| Scheduler validation (#118) | **NOT RUN** | measurable only after merge, on natural runs |
| Sentry | **PASS** for the current deployment | `39128538815`, 2026-10-18; re-verified at the soak start |
| Lead time under 10 hours | **NOT RUN** | production read; operator |
| Legal approval | **BLOCKED** | `docs/launch-human-decisions.md` §1, now including erasure scope (F-21) |
| Operator identity | **BLOCKED** | same, §2 |
| Test mailbox | **BLOCKED** | same, §3 |
| Branch protection | **NOT CONFIGURED** | owner setting |

## 9. Owner decisions

1. **The `braces` audit gate.** Options: (a) wait for an upstream fix; (b) a
   time-boxed exception for GHSA-vfj7-8cjw-p6xm only, justified by the
   evidence in §6 (dev-only, no runtime trace, no fix); (c) accept a red audit
   job. #121 makes this decision non-blocking for code review. **Recommended:**
   (b) with an expiry date, or (c), but never (b) without an expiry.
2. **Branch protection**, with the checks listed in §7.
3. **Erasure scope (F-21)**, with the legal reviewer: what redaction must
   remove, and the notice made to match.
4. **If #118 under-delivers:** Supabase `pg_cron` + `pg_net` (recommended for
   the reminders tick), Vercel Cron, or an external dispatcher (but that turns
   runs into `workflow_dispatch`, which this project excludes from evidence).
5. **Positive reminder evidence in every soak window** (after #119): if wanted,
   add it as an explicit soak gate.
6. **Waitlist notifications from UI cancellations (F-5).**
7. **Short lead times (F-7)**, if the gate query is non-zero.

## 10. How the evidence was produced, and what it does not establish

- Local PostgreSQL only: the dev database for unit and integration runs, a
  fresh seeded UTC database for the invariants suite, and a separate disposable
  database for the browser suite. Every URL was checked to be loopback (and a
  `*test` database where required), and no credential was printed.
- True exit codes throughout. Every control added was switched off and the red
  tests counted (in each PR description).
- **Not established:** anything in production. Every production gate in §8 is
  open. CI's browser suite and the local one ran against CI-style seeded data,
  not production data.
