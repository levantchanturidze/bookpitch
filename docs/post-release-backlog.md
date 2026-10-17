# Post-release backlog round — 2026-10-17

**Status: nine engineering PRs open, none merged. New release gate NOT STARTED.**

This round implemented the post-release backlog (items A–H) after the certified
release `fdf6559`, each item in its own PR against `main`, plus one dependency
PR the baseline audit made necessary. Nothing was merged, deployed, migrated or
changed in production. The certified release and its evidence are untouched.

This file is the round's record and the plan for the next release gate. The
decisions only a person can make before launch are in
`docs/launch-human-decisions.md`. Current production state lives in
`docs/release-state.md`, which this round did not change.

> **Merging this PR is a production change.** Vercel deploys every push to
> `main`, so even a docs-only merge gives production a new deployment id. That
> moves it off the certified deployment of `fdf6559`. This PR belongs to the next
> release gate like the others.

## 1. Baseline integrity (re-observed, read-only)

Every row was read from GitHub's records on 2026-10-17, not carried over from
earlier documents.

| Fact | Observed |
|---|---|
| `origin/main` | `fdf6559891788a41b545ae5823de89b5f3a1689f`, unchanged by this round |
| Production deployment | `6769046032`, sha `fdf6559`, created 2026-09-30T20:09:21Z |
| Certification | soak **#110** closed 2026-10-03T02:05:58Z, certifying `fdf6559` / `6769046032`. Its evidence comment and issue were not touched |
| Combined commit status of `fdf6559` | `success` |
| Open PRs at the start of the round | none |
| Production monitor | red. Latest scheduled run `39019948504` (2026-10-17T09:07Z): **exactly one** failing check, `reminders-missed NOT VERIFIED` (0 appointments owed a reminder in 48 h). Every other check passes |
| Open `ops-incident` issues | **#90** only. It was reopened on 2026-10-05 by that empty window, five days after it closed on a real sample. See §5, F-12 |

## 2. Disposition

| Item | Disposition | PR |
|---|---|---|
| A — one practitioner double-booked across their staff rows | **PR READY** (carries the round's only migration) | #112 |
| B — reminder templates and lead time editable by any booking editor | **PR READY** | #113 |
| C — waitlist mutations unaudited | **PR READY**, plus a data-loss fix found on the way (F-4) | #114 |
| D — a resend left the old verification email queued | **PR READY** | #115 |
| E — location switcher offers every location to every member | **PR READY** | #116 |
| F — refused Server Actions surface as a 500 digest | **PR READY** | #117 |
| G — scheduled workflows delivered far below their schedule | **PR READY** (schedules only). Its effect can only be measured on natural runs after merge | #118 |
| H — an empty `reminders-missed` window is a failing gate | **PR READY**. Incident #90 stays open; this PR is not evidence for ending it | #119 |
| (baseline) — new HIGH advisories since certification | **PR READY** for the two with a fix. `braces` has no fix: **BLOCKED — OWNER DECISION** on the CI gate (§7) | #111 |

## 3. PR inventory

All nine PRs: base `main` at `fdf6559`, open, not draft, mergeable, unmerged.

| PR | Branch | Head | CI run (`CI` / `PR body`) | Local `npm run test` | Migration |
|---|---|---|---|---|---|
| #111 | `chore/deps-audit-2026-10-17` | `03f4177` | `38976295551` / `38976295531` | 148 files, 2259 passed, 47 skipped | none (lockfile only) |
| #112 | `fix/cross-location-double-booking` | `6887c37` | `38978512198` / `38978512160` | 149 files, 2286 passed, 51 skipped | `20261017000001_practitioner_double_booking` |
| #113 | `fix/reminder-settings-rbac` | `95c539d` | `38979364300` / `38979364291` | 149 files, 2279 passed, 47 skipped | none |
| #114 | `feat/waitlist-audit-trail` | `b9e60fc` | `38980181621` / `38980181595` | 149 files, 2271 passed, 47 skipped | none |
| #115 | `fix/verification-email-supersession` | `da10c72` | `38981195556` / `38981195535` | 149 files, 2272 passed, 47 skipped | none |
| #116 | `fix/scoped-location-switcher` | `118a5a8` | `39026811125` / `39026811101` | 149 files, 2283 passed, 47 skipped | none |
| #117 | `fix/server-action-typed-denials` | `2df169f` | `39027626792` / `39027626788` | 150 files, 2288 passed, 47 skipped | none |
| #118 | `fix/scheduler-resilience` | `ad23f74` | `39028515998` / `39028515978` | 148 files, 2263 passed, 47 skipped | none |
| #119 | `fix/monitor-verification-semantics` | `f12c09d` | `39028492098` / `39028492064` | 148 files, 2267 passed, 47 skipped | none |

**Every `CI` run has the same per-job result.** `Lint, type-check, test, and
build` fails at step 6, *Audit dependencies*, and its 16 later steps are skipped.
`Browser, mobile, and accessibility suite` passes. `Secret scanning` passes.
Every `PR body` run passes. So **lint, type-check, unit/integration tests and the
build have not run in CI for any of these PRs.** The local results above and in
each PR description are the evidence for them, and §6 makes that a gate step.
Each PR's comments record its runs.

The skips are the superuser-only invariants suite, which needs a fresh seeded
database. #112's four extra skips are its new check-9 cases. That suite was run
separately: 52/52 on #112, and 52/52 on the combined tree (§4).

What each PR fixes, its root cause, its tests and its production verification
are in its description. In short:

| PR | Root cause | Controls proven by perturbation (control off → tests red) |
|---|---|---|
| #112 | The only guard, `no_staff_double_booking`, is keyed on the staff **row**. One person linked at two locations is two rows, so two calendars. | booking trigger 13, link trigger 1, picker 1, link conflict mapping 1, verifier check 9c 1 |
| #113 | Both actions were gated by `booking.update` in list mode, which every PROVIDER and FRONT_DESK holds. The lead-time change wrote no audit row. | gate 6, lead-time audit 2, read-only UI 3 |
| #114 | No `waitlist` audit entity existed. **And** a bare `catch {}` inside the cancel transaction made any fan-out failure silently roll back the cancellation while the route answered 200. | savepoint 1, create audit 2, delete audit 3, notified audit 1 |
| #115 | Sign-up withdrew queued earlier verification emails; the resend path did not. Withdrawn mail was recorded as `dead`, the state the monitor alarms on. | resend supersession 1, claim predicate 1, drain withdrawal 3, `cancelled` not `dead` 1, sweep 1, `deliverNow` check 1 |
| #116 | `loadLocationsForOrg` returned every location to every member, and a cookie could select any of them. | 16, 8, 8, 2, 3 (five controls; see the PR) |
| #117 | Refusals were **thrown** out of the actions, and the framework masks a thrown error as a 500 digest. | `unstable_rethrow` 3, typed refusals 12, client reads the result 3, book wrapper 3 |
| #118 | GitHub delivers each `cron:` line about five times a day, whatever it asks for. | 1, 2, 1, 1 (see the PR) |
| #119 | "Nothing to measure" was emitted as a failing gate, not as `NOT VERIFIED` information. | 5, 3, 3 (see the PR) |
| #111 | Three HIGH advisories published after certification. `sharp` is runtime (next/image). | n/a, lockfile only |

## 4. Integration rehearsal: merging all nine

Each PR was verified alone against `fdf6559`. To learn what merging *all* of
them does, they were merged into a throwaway local branch, never pushed and
since deleted, in the order #111 (fast-forward), #119, #118, #113, #112, #114,
#115, #116, #117. The suite was then run on the result.

**Textual conflicts: one pair.** #117 conflicts with #113 in
`components/reminders/actions.ts` (the two declaration lines, where #113 changed
the gate and #117 renamed the functions to `*Impl` wrappers) and in
`components/reminders/RemindersView.tsx` (the template card, where #113 added an
`editable` branch and #117 a result-reading form). Resolution: keep #113's
`REMINDER_SETTINGS_PERMISSION` and its comment under #117's names, and wrap
#117's form in #113's `editable` branch. Everything else merged cleanly,
including #116 and #117 both editing `tests/branch-scoping.test.ts`, and #118 and
#119 both editing `docs/operations.md`.

**Semantic conflicts: two, invisible to git.** With the textual conflict
resolved, the tree typechecked, linted and built, and then **12 tests failed**,
all in #113's `tests/reminder-settings-rbac.test.ts`:

| Cause | Failures | Mechanism |
|---|---|---|
| #113 × #117 | 7 | #113's refusal tests expect a thrown `ForbiddenError` / `InvalidInputError`. #117 makes those refusals typed results: `{ ok: false, code: 'forbidden' \| 'invalid_input' }` |
| #113 × #116 | 5 | #113's page test mocks `loadLocationsForOrg`, which #116 renames to `loadLocationsForCaller`. The real loader then ran: `cookies()` outside a request scope for owner, admin and provider. Front desk and branch manager got #116's "No location assigned" page |

Neither PR is wrong alone. #113's and #116's descriptions had called their
overlap textual only, and #117's described only its textual conflict with #113.
Those descriptions have been corrected.

**Reconciliation, proven in the rehearsal tree:** mock `loadLocationsForCaller`.
Assert the typed refusals. Keep every "unchanged in the database, nothing
audited" assertion as it is. Additionally assert `{ ok: true }` on the allowed
twins.

<details>
<summary>The exact change to <code>tests/reminder-settings-rbac.test.ts</code></summary>

```diff
-  return { ...actual, loadLocationsForOrg: locationMock };
+  return { ...actual, loadLocationsForCaller: locationMock };
-const { ForbiddenError, InvalidInputError } = await import('@/lib/auth');
-// the thrown error, and sits beside the allowed twin.
+// the typed refusal, and sits beside the allowed twin.
-    await saveTemplateAction(fd({ channel: 'sms', body: `new text by ${who}` }));
+    await expect(
+      saveTemplateAction(fd({ channel: 'sms', body: `new text by ${who}` })),
+    ).resolves.toMatchObject({ ok: true });
       await expect(
         saveTemplateAction(fd({ channel: 'sms', body: 'Click http://evil.example to confirm' })),
-      ).rejects.toBeInstanceOf(ForbiddenError);
+      ).resolves.toMatchObject({ ok: false, code: 'forbidden' });
-      await saveLeadHoursAction(fd({ hours: '12' }));
+      await expect(saveLeadHoursAction(fd({ hours: '12' }))).resolves.toMatchObject({ ok: true });
-      await expect(saveLeadHoursAction(fd({ hours: '9' }))).rejects.toBeInstanceOf(ForbiddenError);
+      await expect(saveLeadHoursAction(fd({ hours: '9' }))).resolves.toMatchObject({
+        ok: false,
+        code: 'forbidden',
+      });
-    await expect(saveLeadHoursAction(fd({ hours: '1' }))).rejects.toBeInstanceOf(InvalidInputError);
+    await expect(saveLeadHoursAction(fd({ hours: '1' }))).resolves.toMatchObject({
+      ok: false,
+      code: 'invalid_input',
+    });
```

</details>

| Check on the reconciled combined tree | Result |
|---|---|
| `#113`'s file | 20/20 |
| Its gate reverted to `booking.update` | **6 red**, the same as #113 alone |
| The page's `canEditSettings` forced `true` | **3 red**, the same as #113 alone |
| `npm run test` | exit 0. **155 files, 2396 passed, 51 skipped (2447)**. That is main's 2259 plus each PR's new tests (137); the 51 skips are main's 47 plus #112's four check-9 cases. Guards: 107 entry points, all guarded. Orphan permissions: OK. Reachability: 131 entry points, OK |
| `tsc --noEmit` / `lint` / `format:check` / `next build` | exit 0 / 0 (0 errors, main's 11 warnings) / 0 / 0 |
| Invariants suite, fresh seeded UTC database with all 75 migrations | **52/52** |

Afterwards #112's migration was rolled back out of both local databases with its
written rollback, including the ledger row. Each was verified at 74 migrations
with zero #112 functions or triggers.

**Why this matters for the gate:** CI cannot catch either conflict today. Its
quality job stops at the dependency audit before tests run (§3), and `main` has
no branch protection (R-07). Merging #113 and then #116 through GitHub would
leave `main` red with nothing in CI to say so. See §6.

## 5. Findings recorded this round

Beyond the eight backlog items. Each was observed or measured, not inferred.

| # | Finding | Status |
|---|---|---|
| F-1 | **The CI dependency audit is red by construction.** `braces <= 3.0.3` (GHSA-vfj7-8cjw-p6xm), lint-only via `eslint-config-next`, has no patched release. Every PR's quality job stops before lint, type-check, tests and build. | **Owner decision**, §7 |
| F-2 | `sharp < 0.35.5` (GHSA-wq5f-xc86-pv6w) ships in the certified release's **runtime**, behind Next's `/_next/image` optimizer (no product page uses `next/image`). `source-map-js` (build/test) also has a fix. | Fixed in #111, lockfile only |
| F-3 | Superseded verification and reset mail was recorded as `dead`, the state the monitor's `outbox-dead-letters` check and the soak's `outbox-clean` gate alarm on. A user asking twice for a reset would open a false incident. The runbook's dead-letter retry query would have **resent stale reset links**. | Fixed in #115 (`cancelled`, `superseded`) |
| F-4 | **A swallowed error inside a Prisma interactive transaction silently rolls back the whole transaction while the callback resolves.** In `PATCH /api/appointments/[id]` a failed waitlist fan-out erased the cancellation and its audit row while the route answered 200. Measured: the row stayed `pending`. | Fixed in #114 (savepoint). It was the only such swallow in production code |
| F-5 | The scheduler UI cancels through `updateAppointmentAction`, which never calls `notifyWaitlistForCancelled`. Only the API route does, so "slot opened" waitlist notifications do not fire from the product UI. | **Documented, not fixed**: a product decision (§7) |
| F-6 | GitHub throttles each `cron:` line to about five runs a day, independently per line. The monitor's single line had a p50 gap of 5.0 h and a max of 9.0 h; 84% of 24 h windows held a gap over the soak's 6 h limit. | #118. Measurements in `docs/scheduler-resilience.md` (on #118) |
| F-7 | The reminders tick has gone up to **9.9 h** between runs, while `MIN_REMINDER_LEAD_HOURS = 8` was calibrated on a 4 h 40 m worst case. An organisation with a lead time under about 10 h can have an appointment start inside a gap and never be reminded. | Mitigated by #118. A release-gate query and an owner decision (§6, §7) |
| F-8 | `safeAction` caught `redirect()` / `notFound()` as internal failures. Latent on `main`: no wrapped action redirects yet, and #117's card checkout would have been the first. | Fixed in #117 (`unstable_rethrow`) |
| F-9 | Billing's `<form action>` in a server component **discards** the action's result, so every billing refusal would be silent once typed. | Fixed in #117 (`PaymentButtons`) |
| F-10 | Test teardowns swallow errors **inside a transaction**: `tests/onboard-activation.test.ts` lines 46–54 and 153–154 (`tx.….catch(() => {})`). That is F-4's shape. One failed delete aborts the transaction, every later statement fails silently, and the teardown commits nothing, leaking fixtures without a sign. | **Documented, not fixed**: test hygiene, separate PR |
| F-11 | **Documented migration rollbacks leave the ledger row.** 36 of the 74 migrations document a rollback; **none** mentions `_prisma_migrations`. `20260929000001_scoped_rbac_links`, for example, drops its objects and stops. After such a rollback the next deploy reports "No pending migrations" and the objects stay absent; only an invariants check would notice. `prisma migrate resolve --rolled-back` is refused for a migration that succeeded (P3012, measured). | **Documented, not fixed.** Applied migration files must not be edited. Whoever runs one of those rollbacks must also `DELETE FROM _prisma_migrations WHERE migration_name = '<name>'` in the same transaction, as #112's header does |
| F-12 | Incident #90 was reopened on 2026-10-05 by an empty window, with no new evidence, five days after it closed on a real sample. The monitor has been red since for that alone. | #119 stops the empty window failing the run. **#90 itself must close on real evidence**, §6 |
| F-13 | #113 × #116 and #113 × #117 conflict semantically (§4). | Reconciliation documented and proven |
| F-14 | **Merging #112 applies its migration to production.** `migrate.yml` runs on any push to `main` touching `prisma/migrations/**` or `scripts/verify-production-invariants.sql`. | Gate step: the preflight runs **before** the merge, §6 |

## 6. Recommended next release gate

Nothing below has started. It is the plan for when the owner opens the gate.

### Before and during merging

1. **Decide the CI audit gate (F-1).** Until it is decided, CI checks no PR's
   tests or build, and cannot see conflicts like §4's. If it stays red, every
   merge must be preceded by a local full-suite run on the rebased head (step 3
   below), and that becomes the only test evidence.
2. Optionally, decide branch protection (R-07). §4 is a concrete case of what
   it would catch, once the CI gate can go green.
3. **For every PR, at merge time:** rebase on the then-current `main` and run
   `format:check`, `lint`, `tsc --noEmit`, `next build` and `npm run test`
   locally, reading **true exit codes** (never `cmd | tail; echo $?`). Merge
   only on green. After merging, read the push CI run on the merge commit,
   attempt 1, from the unfiltered run listing.

### Merge order (the rehearsed one)

| Step | PR | Handling |
|---|---|---|
| 1 | #111 deps | Runtime change (`sharp`). No product page uses `next/image` and `public/` holds only SVGs, so there is no product image path to exercise; `sharp` is reachable only through Next's `/_next/image` endpoint. UAT is a smoke check: the deployment serves `/api/health` → `{"ok":true}` |
| 2 | #119 H | Before or with G, so G's extra monitor runs do not each report the empty window as a failure |
| 3 | #118 G | **Changes live schedules.** Merge before any soak |
| 4 | #113 B | — |
| 5 | #112 A | **The merge is the migration (F-14).** Run the preflight in `docs/practitioner-double-booking.md` (on #112) **before merging**: a non-zero count is a real person double-booked, to be resolved with the organisation first. After the merge, `migrate.yml` must show the migration applied, no drift, and `ok: practitioner double-booking guard` |
| 6 | #114 C | — |
| 7 | #115 D | First housekeeping run after deploy deletes `cancelled` rows older than 30 days (withdrawn verification emails, previously kept forever) |
| 8 | #116 E | **Rebase must rename the mock** in `tests/reminder-settings-rbac.test.ts` (§4) |
| 9 | #117 F | **Rebase must resolve the conflict** with #113 and **convert #113's seven refusal assertions** (§4) |

Steps 8 and 9 do for #113's new test file exactly what #116 and #117 already do
for the existing tests that pinned the old contracts.

### Migrations

One: `20261017000001_practitioner_double_booking` (#112). CREATE FUNCTION and
CREATE TRIGGER only, with no row read or written. Its lock is bounded by a 5 s
`lock_timeout`, and the abort path was proven to leave nothing behind. The
written rollback is in its header and was proven byte-identical to the
predecessor schema; it deletes the ledger row (F-11). Applied in CI by #112's
`e2e` job (run `38978512198`). Never applied to production by this round.

### Tests to repeat at the gate

- The per-merge local run above, on each rebased head.
- The invariants suite on a fresh seeded UTC database for the final tree
  (`INVARIANT_TEST_DATABASE_URL`), expecting 52/52.
- `migrate.yml`'s verifier output after step 5.
- The push CI run on every merge commit, and the browser suite.

### Production UAT gates

Synthetic UAT organisation and its existing fixtures only. Never a customer, and
never a production membership changed to make a test possible. Pair every
crafted refusal with a crafted allowed call, as in C7.

| PR | Gate |
|---|---|
| #112 | Link a provider at two locations. Book A at 10:00, try B at 10:30 → 409; B at 11:00 → OK. The picker at B hides 10:00 |
| #113 | The UAT provider and front desk see the settings read-only, and a crafted `saveTemplateAction` is refused. The owner's lead-time change appears in `/audit` with `previous` |
| #114 | Add and remove a waitlist entry; `/audit` filtered on `waitlist` shows both with the right actor. Cancel a matching appointment **through the API route** and see a per-entry `notified` row |
| #115 | **Blocked until a test mailbox is designated** (`docs/launch-human-decisions.md`, item 3). Then: sign up, force a resend, exactly one working email arrives, and `outbox-dead-letters` stays green |
| #116 | FD-A's switcher offers only location A; a hand-set cookie for B still shows A; FD-0 sees "No location assigned"; the owner sees every location |
| #117 | A crafted refused `sendNowAction` / `saveTemplateAction` answers **200 with a typed `{ ok: false, code }`**, not a 500 digest, and changes nothing. The card button still reaches the gateway |
| #118 | Natural runs only, never dispatched. Over 7 days: monitor runs ≥ 15/day, monitor max gap < 5 h, < 5% of 24 h windows with a gap over 6 h, reminders and housekeeping union max gap < 6 h, zero cancelled scheduled monitor runs. If it fails, **do not raise thresholds**: see §7 |
| #119 | The monitor stops failing on an empty window, and #90 stays open |

Plus the read-only, no-PII gate query from F-7:
`SELECT count(*) FROM organizations WHERE reminder_lead_hours < 10;`

### Before a soak can certify the new release

- Every merge done, and the final SHA served on both canonical hosts.
- #118's delivery criteria met on natural runs. Otherwise the soak restarts on
  `observation-gap` or `cron-outcomes`.
- **#90 closed by the canonical automation** on a natural scheduled run that
  measured a real owed-and-delivered appointment, from organic traffic or a
  sentinel appointment in the UAT organisation with the designated test mailbox.
  **Never closed by hand.** No other `ops-incident` open (`no-incident-in-window`).
- Sentry verified by `release-verify-and-soak.yml`, which also starts the soak.
- The F-7 query answered, and the owner's decision on it recorded.
- `fdf6559`'s certification (#110) stays the record for `fdf6559` and
  deployment `6769046032` only. The new release needs its own window.

## 7. Owner decisions raised this round

None of these block review of the PRs. The launch-blocking decisions are in
`docs/launch-human-decisions.md`.

1. **The CI audit gate (F-1).** (a) Wait for an upstream `braces` fix.
   (b) Add an explicit, time-boxed exception for GHSA-vfj7-8cjw-p6xm only,
   justified as lint-only with no fix available. (c) Accept a red audit step
   until (a). `npm audit fix --force` would downgrade `eslint-config-next` to
   14.2.35 and is not an option. Until this is decided, CI is not a test gate.
2. **Branch protection (R-07)**: a deferred configuration choice since
   2026-09-09. §4 is evidence of what it would catch, once (1) lets CI go green.
3. **If #118's post-merge criteria fail:** Supabase `pg_cron` + `pg_net` (free;
   recommended for the reminders tick), Vercel Cron (Pro), or an external
   dispatcher (free, but it turns runs into `workflow_dispatch`, which this
   project excludes from evidence). Costs and evidence-model impact are in
   `docs/scheduler-resilience.md` (on #118).
4. **Positive reminder evidence per soak window.** After #119 a soak whose
   window has no eligible appointments can certify with `reminders-missed`
   reported `NOT VERIFIED`. If every window must carry a delivered reminder, that
   belongs in an explicit soak gate, not a permanently red monitor.
5. **Waitlist notifications from the product UI (F-5).** Making UI
   cancellations notify the waitlist starts sending staff notifications they do
   not get today.
6. **Short lead times (F-7).** If the gate query returns a non-zero count:
   raise `MIN_REMINDER_LEAD_HOURS`, tell those organisations, or move the
   reminders tick off GitHub's scheduler (3).

## 8. How the evidence was produced

- **Local PostgreSQL only.** The full suite ran against the local development
  database. The invariants suite ran against a fresh seeded UTC database built
  from migrations and seed, as CI does. #112's migration gate ran against a
  predecessor database built from `origin/main`'s 74 migration files. Disposable
  databases followed the naming rule `bookpitch_*test`. Every connection was
  checked to be loopback before use.
- **No credential printed.** Connection URLs were derived in Node and passed
  only through a child process's environment (CLAUDE.md, F-12 rule).
- **True exit codes.** One early check piped `tsc` through `tail` and reported
  `tail`'s status. Every result above was re-read from an unpiped run.
- **#112's migration was on the development database only while a tree
  containing it was under test.** It was rolled back with ledger deletion each
  time, and verified absent.
- **Perturbation, not just passing tests.** Each control was switched off and
  the resulting red tests counted (§3). A control no test notices was treated as
  untested.

## 9. Not established by this round

- Nothing here has been verified in production. Every PR's production gate
  is open.
- CI did not run lint, type-check, tests or build for any PR (F-1).
- #117: the HTTP status of a crafted action POST against a running server was
  not measured locally; the C7 probe repeats it in production UAT.
- #115: delivery to a real inbox has not been observed; no test mailbox exists.
- #118: GitHub's delivery under the new schedules can only be measured after
  merge, on natural runs.
- The rehearsal proves the final combined tree, not every intermediate state of
  the merge order. Each rebased head gets its own full run at the gate (§6).
