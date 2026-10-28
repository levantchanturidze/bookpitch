# Post-release backlog: round record and release plan

**Status on 2026-10-28: 17 pull requests open (#111–#127), none merged. New
release gate NOT STARTED.** Production is the certified release `fdf6559`,
unchanged throughout this work.

The decisions only a person can make before launch are in
`docs/launch-human-decisions.md`. Current production state lives in
`docs/release-state.md`. The legal review's open items are in
`docs/legal-review-checklist.md`.

> **Merging any of these is a production change.** Vercel deploys every push to
> `main`, so every merge gives production a new deployment id, moving it off the
> certified deployment. Two merges also run `migrate.yml` against production:
> #112 applies its migration and changes the invariant verifier, and #122
> changes the verifier. The next release gate decides when (§9).

## 1. Baseline (re-observed 2026-10-28, read-only)

| Fact | Observed |
|---|---|
| `origin/main` | `fdf6559891788a41b545ae5823de89b5f3a1689f`, unchanged since 2026-09-30 |
| Production deployment | `6769046032`, sha `fdf6559`, created 2026-09-30T20:09:21Z |
| Certification | soak #110, closed 2026-10-03, certifying `fdf6559` / `6769046032`. Untouched |
| Production monitor | run `40598209604` (2026-10-27T22:53Z, scheduled): 26/29 checks passed. The one failure is `reminders-missed NOT VERIFIED`: no appointment was owed a reminder in 48 h. Same state as on 2026-10-18 |
| Open `ops-incident` | #90 only (reopened 2026-10-05 by the empty window; see #119) |
| Sentry re-verification | run `40581604800`, 2026-10-27T20:50Z, scheduled: success |
| Backups | run `40463152970`, 2026-10-27T06:47Z, scheduled: success. Restore drill last green `37193588304`, 2026-10-04 |
| Branch protection on `main` | none (`404 Branch not protected`) |
| Repository security settings | Dependabot alerts **disabled**, Dependabot security updates disabled, secret scanning disabled, push protection disabled (DEF-20) |
| `npm audit` on `main`'s lockfile | **2 critical, 5 high, 3 moderate**, across `next`, `@sentry/nextjs`, `sharp`, `undici`, `zod`, `fast-uri`, `source-map-js`, `vite`, `vitest`, `@vitest/mocker`. All have published fixes; #111 applies them (§6) |

## 2. The pull requests

All target `main` (base `fdf6559`). Every branch contains #121's CI split,
merged in on 2026-10-18 so that its own CI runs the code checks.

| PR | Branch | Head | What it does | Depends on |
|---|---|---|---|---|
| #121 | `ci/independent-dependency-audit` | `87153fc` | The dependency audit is its own CI job, so its failure no longer hides the code checks. Not weakened. The branch-protection rule to apply names all five checks (`docs/release-state.md` §4) | — |
| #111 | `chore/deps-audit-2026-10-17` | `afb7dd6` | **Security hotfix candidate.** `next` 16.4.3, `@sentry/nextjs` 10.76.2, `sharp` 0.35.5, `undici` 7.30.1 and others: `npm audit` 0 at every severity | — |
| #112 | `fix/cross-location-double-booking` | `45ae78d` | **The only migration.** One practitioner cannot be booked in two places across their staff rows. Check 9, a tested read-only preflight, a recovery table | — |
| #113 | `fix/reminder-settings-rbac` | `5846366` | Reminder templates and lead time need `org.settings.update:org`; the lead-time change is audited, under a row lock | — |
| #114 | `feat/waitlist-audit-trail` | `3b2251a` | Waitlist audit trail, including entries removed with a customer, audited exactly once. Savepoint fix for a silent rollback. Explicit org filters | — |
| #115 | `fix/verification-email-supersession` | `dce91e9` | A resend withdraws the old verification email, also after it was claimed; withdrawn mail is `cancelled`, not `dead` | — |
| #116 | `fix/scoped-location-switcher` | `12b04d4` | The location switcher offers only reachable locations | — |
| #117 | `fix/server-action-typed-denials` | `461857f` | Refused Server Actions return a typed result, not a 500 | **contains #113** |
| #118 | `fix/scheduler-resilience` | `30ae8cc` | More schedule lines (GitHub throttles each line), plus tests proving overlapping runs are safe | after #119 |
| #119 | `fix/monitor-verification-semantics` | `9a60698` | An empty reminder window is `NOT VERIFIED`, not a failure. Does not end #90 | — |
| #120 | `docs/post-release-backlog` | this PR | This record, the launch decisions, the legal checklist | — |
| #122 | `fix/verify-trigger-states` | `c37298e` | The verifier refuses replica-only tenant-isolation triggers and an effective `session_replication_role = replica`, at every level including the server's | — |
| #123 | `test/teardown-failures-visible` | `59324d2` | Test teardowns no longer swallow DB errors inside transactions; a static check keeps it that way | — |
| #124 | `docs/migration-rollback-inventory` | `c90f20b` | Rollback rules and inventory for the 74 applied migrations, plus a test holding new migrations to one complete rollback transaction | — |
| #125 | `fix/auth-tenancy-hardening` | `130956d` | Constant-time bearer checks, push-unsubscribe ownership, send-now's explicit org filter | — |
| #126 | `fix/erasure-minimisation` | `eceebc5` | Erasure removes waitlist entries and delivery contents, copies the name nowhere, and nothing new can attach to a redacted customer | **stacked on #114** |
| #127 | `fix/db-clock-reset-atomicity` | `5e9f81f` | Password-reset expiry on the database clock, and a race-free single use | — |

## 3. CI status at each head

| PR | Head | CI run | Code checks | Browser suite | Secret scan | PR body | Dependency audit |
|---|---|---|---|---|---|---|---|
| #111 | `afb7dd6` | `40104675087` | pass | pass | pass | pass | **pass** |
| #112 | `45ae78d` | see the PR's CI comment | | | | | |
| #113 | `5846366` | `39152087416` | pass | pass | pass | pass | fail |
| #114 | `3b2251a` | `40143187022` | pass | pass | pass | pass | fail |
| #115 | `dce91e9` | `40604856132` | pass | pass | pass | pass | fail |
| #116 | `12b04d4` | `39152097386` | pass | pass | pass | pass | fail |
| #117 | `461857f` | `39152100259` | pass | pass | pass | pass | fail |
| #118 | `30ae8cc` | `39152102456` | pass | pass | pass | pass | fail |
| #119 | `9a60698` | `39152106466` | pass | pass | pass | pass | fail |
| #121 | `87153fc` | `40142057430` | pass | pass | pass | pass | fail |
| #122 | `c37298e` | `40142776360` | pass | pass | pass | pass | fail |
| #123 | `59324d2` | `40112107258` | pass | pass | pass | pass | fail |
| #124 | `c90f20b` | `40142458247` | pass | pass | pass | pass | fail |
| #125 | `130956d` | `40139452758` | pass | pass | pass | pass | fail |
| #126 | `eceebc5` | `40144054671` | pass | pass | pass | pass | fail |
| #127 | `5e9f81f` | `40139752027` | pass | pass | pass | pass | fail |

The audit fails on `main`'s lockfile, which every branch but #111 carries, and
on nothing any of these PRs change. It is red under its own name, and no
exception, allowlist or threshold change is configured. After #111 merges, a CI
re-run on each PR audits the lockfile merged with `main`.

CI runs the invariants suite with nothing skipped, including the cluster-wide
`ALTER SYSTEM` case of check 2b (59 tests in that file on #122's run). #120's
own run is in its CI evidence comment.

## 4. Every PR merged together (local rehearsal, 2026-10-28)

All seventeen heads were merged into a throwaway local branch built from
`origin/main`, never pushed. **No textual conflict.** The one real conflict,
#113 with #117, is resolved inside #117's branch.

| Check, combined tree `8645b08` | Result |
|---|---|
| `npm ci` | exit 0 |
| `format:check` / `lint` / `tsc --noEmit` | exit 0 / 0 (0 errors, `main`'s 11 warnings) / 0 |
| `npm run test` (vitest, guards, orphan permissions, reachability) | **exit 0. 164 files, 2488 passed, 68 skipped.** The skips are the invariants suite's database cases, run separately below |
| Invariants suite, fresh seeded UTC database, 75 migrations, `ALTER SYSTEM` case opted in | **69/69**. Afterwards the server's `session_replication_role` was `origin` from `default` |
| `next build` | exit 0 |
| Browser suite (all 9 projects, disposable database, CI's environment) | **266 passed, 3 skipped (269)**; `e2e:check`: all 9 required suites executed |
| `npm audit`, every severity | **0** |
| gitleaks over every commit the PRs add (redacted output) | **0 findings** (37 commits); full history 0 (474 commits, 2026-10-25) |
| #112's rollback, run verbatim from its header | schema byte-identical to the 74-migration baseline (`pg_dump -s -O -x`, apart from its per-dump `\restrict` key); a later deploy re-applies cleanly |

#112's head moved to `45ae78d` after this rehearsal (the predicate fix,
DEF-35); its own suites and the invariants suite were re-run on it (§8). After
each run, #112's migration was rolled back out of both local databases, ledger
row included, and verified at 74 migrations.

The combined diff was reviewed for accidental changes: no skipped, focused or
deleted tests, every changed assertion in an existing test replaced by an equal
or stronger one, no change to `.gitleaks*`, `AGENTS.md`, `CLAUDE.md` or `.env*`.

## 5. Defect ledger

P0 none found. Severity is impact if triggered, not likelihood. "Red" counts
are the tests that fail when the fix is removed.

| ID | Sev | Subsystem | Defect, and its root cause | Fix (PR, commit) | Tests and verification | Depends on |
|---|---|---|---|---|---|---|
| DEF-01 | P1 | Dependencies | Advisories in the deployed runtime: `next` (Server Actions DoS, applies; image-optimizer RCE, not established here; `use cache` RCE, not used), `@sentry/nextjs` (tunnel bypass; `tunnelRoute` unset), `sharp` (librsvg). Published after the certified build; nothing in the repo changed | #111 `afb7dd6` | `npm audit` 0; CI all green incl. audit; local suite and build; browser suite 266 | owner release window |
| DEF-02 | P2 | Verifier | Check 2b failed a `replica` default that a more specific `origin` one overrides: precedence ignored | #122 `b9603a1` | invariants; ignoring precedence: 1 red | — |
| DEF-03 | P2 | Tests | The swallowed-error guard missed `.catch(error => {})` and selective handlers | #123 `59324d2` | complements for 8 handler forms | — |
| DEF-04 | P2 | Migration safety | The rollback-docs test passed any comment quoting the ledger delete | #124 `4effcb1` | 8 tests; #112's real migration | — |
| DEF-05 | P3 | Auth | Seven bearer routes compared the secret with `!==` (CWE-208) | #125 `6ffa26c` | every route 401s 4 wrong headers; static check; 1 red | — |
| DEF-06 | P3 | Push | `POST /api/push/unsubscribe` deleted by endpoint alone (IDOR) | #125 | route and library tests; 2 red | — |
| DEF-07 | P2 | Tenancy | send-now's ownership check, the only barrier before an RLS-bypassing send, relied on RLS alone | #125 | RLS forced off in the test; 1 red | — |
| DEF-08 | P3 | Tenancy | 135 of 150 tenant queries name no `organization_id` (95 in `withOrg`, 26 taking a `tx`, 13 in bypass contexts, all 13 reviewed). Defence in depth, against CLAUDE.md invariant 1 | fixed where touched (#114, #125, #126); the rest **documented** | — | owner: schedule a sweep |
| DEF-09 | P2 | Privacy | Erasure left waitlist notes, delivery records (address, a body with the name), and copied the name into the audit log and a notification | #126 `a3ce3e5` | 3 tests; 4 perturbations | #114 |
| DEF-10 | P3 | Privacy | The payment gateway's description carries the customer's name and service | — | — | **owner decision** |
| DEF-11 | P2 | Privacy, consent | Public booking attaches to an existing customer by unverified email or phone, and stamps consent | — | — | **owner and legal** |
| DEF-12 | P3 | Privacy | Notifications copy names; unread ones are kept until read, and nothing links one to its customer, so erasure cannot find them | disclosed in `/privacy` (#126) | — | **owner decision** |
| DEF-13 | — | Privacy | Appointment notes survive erasure | disclosed in `/privacy` (#126) | — | **legal decision** |
| DEF-14 | P3 | Auth | Reset expiry set and checked by this process's clock | #127 `aa2f8d3` | clock skewed ±2 h; 3 red with DEF-15 | — |
| DEF-15 | P3 | Auth | `consumeReset` check-then-act: two uses of one link, the loser a 500 | #127 | race test | — |
| DEF-16 | P3 | Admin | `deleteStaff` judged "future" by this process's clock (message accuracy; the FK held) | #127 | 1 red | — |
| DEF-17 | P3 | Tests | `probe-routing` pinned the vulnerable `!==` form | #125 `130956d` | the updated test still bites | — |
| DEF-18 | P3 | Tests | A new send-now test depended on order | #125 | cleanup in `beforeEach`; 1 red exactly | — |
| DEF-19 | process | Review | The 2026-10-18 report said Codex never reviewed #116–#124. It reviewed #122, #123 and #124 that day | corrected; findings DEF-02–04 fixed | — | — |
| DEF-20 | — | Repo settings | Dependabot alerts, secret scanning and push protection disabled; no code scanning; no branch protection | — | — | **owner** |
| DEF-21 | P3 | Supply chain | GitHub-owned actions pinned by tag (third-party ones are pinned by SHA) | — | — | owner, optional |
| DEF-22 | env | Local runs | Machine load (78–93 % CPU from file sync) timed out long local runs | CI used as the executor; not a code defect | — | — |
| DEF-23 | P3 | #112 docs | The operator instructions said to use the SQL editor, and the expected output omitted `-q` | #112 `ec51e2c` | verified on a 74-migration database | — |
| DEF-24 | P2 | Privacy | A reminder rendered before an erasure was claimed, written and sent after it, and its notification copied the name | #126 `b719fb2` | 5 race tests; original 4 red | — |
| DEF-25 | P2 | CI governance | The documented branch-protection rule omitted the audit job | #121 `976a5db` | doc ↔ workflow test; 1 red each way | — |
| DEF-26 | P3 | Docs | `operations.md` §16 still said `braces` had no fix | #121 `87153fc` | — | — |
| DEF-27 | P2 | Migration safety | A ROLLBACK block could hold a second transaction and pass | #124 `c90f20b` | 4 red with the rule off | — |
| DEF-28 | P2 | Verifier | A server-level `session_replication_role = replica` was not read | #122 `c37298e` | `ALTER SYSTEM` case (CI, opted in locally); 2 red | — |
| DEF-29 | P2 | Audit integrity | A customer deletion wrote a second `delete` row for an entry removed meanwhile | #114 `3b2251a` | real interleaving; red on the original | — |
| DEF-30 | P2 | Audit integrity | A slot opening audited as `notified` an entry removed meanwhile | #114 `3b2251a` | real interleaving; red on the original | — |
| DEF-31 | P1 | Privacy | New waitlist entries and bookings could attach to a redacted customer, including through a race with the erasure's lock | #126 `eceebc5` | race and route tests; 6 red on the original | #114 |
| DEF-32 | P2 | Privacy | The erasure's pseudonym hashed a name read before its lock | #126 `eceebc5` | rename race | #114 |
| DEF-33 | P2 | Data loss | The retention sweep erased a customer who booked while it ran | #126 `eceebc5` | booking race; a single-statement re-check also red | #114 |
| DEF-34 | P3 | Email | A verification email claimed before a resend was still sent | #115 `dce91e9` | drain race; red on the original | — |
| DEF-35 | P2 | Migration, verifier | Check 9c, the preflight and the link trigger treated an overlap as upcoming if either booking ended later, so an ended overlap failed the post-migration verifier and blocked links | #112 `2e8e524` | 3 tests; exactly 3 red on the original | — |
| DEF-36 | P3 | Tests | A regression in #126's booking refusal would leak a redacted customer into the shared seed organisation (cleanup order). Found when this round's own perturbation run did exactly that | #126 `eceebc5`; the stray rows removed locally | full suite green afterwards | — |
| DEF-37 | P3 | Docs | Seven PR bodies said the audit fails on `braces` | corrected in the bodies, 2026-10-28 | — | — |

Earlier findings, 2026-10-17 and 10-18, final status: F-1 to F-4, F-6, F-8 to
F-11 and F-13 to F-20 are fixed in their PRs (F-21 became DEF-09 and is fixed
in #126). Two stay open: **F-5**, a UI cancellation does not notify the
waitlist (product decision), and **F-7**, lead times under 10 hours against the
observed tick gaps (a production read and a decision, §9).

## 6. Security posture

| Advisory | Package on `main` | Reaches production? | Status |
|---|---|---|---|
| GHSA-p3m5-59mp-jv5r, high: App Router DoS through Server Actions | `next` 16.3.8 | **yes, and it applies**: the app is built on Server Actions | fixed in #111 (16.4.3) |
| GHSA-2464-fhr4-w9xw, critical: image-optimizer RCE with SVG | `next` 16.3.8 | yes; exploitability here not established (no remote image patterns, SVG off by default) | fixed in #111 |
| GHSA-673q-mjm6-r5xr, critical: RCE in `use cache` | `next` 16.3.8 | no: the code has no `use cache` | fixed in #111 |
| GHSA-mchm-gjx6-7h55, critical: tunnel-route bypass | `@sentry/nextjs` 10.67.0 | no: `tunnelRoute` is unset | fixed in #111 |
| GHSA-wq5f-xc86-pv6w, high: librsvg | `sharp` 0.35.4 | yes (next/image) | fixed in #111 |
| `undici` (8 advisories, 4 high; 5 of them new since 2026-10-25), `zod`, `fast-uri`, `source-map-js`, `vite`, `vitest` | various | no: tests, build and the Prisma CLI | fixed in #111 |
| GHSA-vfj7-8cjw-p6xm, `braces` | — | — | **withdrawn** by GitHub 2026-10-23T12:53Z; not reported any more. Nothing was excepted while it was open |

Also reviewed this round, with no defect found: payment webhooks (signature
verified; the mock gateway refused in production), ownership transfer (scoped),
and the workflows (no `pull_request_target`, no injection from event fields,
pull-request workflows use only `GITHUB_TOKEN`, third-party actions pinned to
a SHA). Secret scanning: CI's gitleaks passes on every PR, and a local gitleaks
run over the full history found nothing.

## 7. Privacy

With #126 merged, a redaction:
- removes the customer's waitlist entries, each audited without its notes;
- clears the address and text of their delivery records, keeping channel,
  state and times;
- writes no name anywhere: the audit row holds an HMAC pseudonym, and the
  notification no name;
- refuses any new waitlist entry or booking for the redacted customer, under a
  lock an erasure serialises with;
- serialises with an in-flight reminder: one rendered before the erasure is
  re-rendered after it, and one already handed to the provider cannot be
  recalled (its record is still cleared).

`/privacy` says so, and lists what survives (draft `2026-10-25.draft-2`). Still
open, for the owner and the legal reviewer: appointment notes, treatment
history (P15-005), notifications (DEF-12), audit rows written before #126 that
hold a `previousName`, public-booking identity and consent (DEF-11), and the
payment description (DEF-10).

## 8. Migration safety

**#112 is the only migration.** Locally verified, most recently on 2026-10-28
with the predicate fix (DEF-35):

| Point | Result |
|---|---|
| Applies from the true predecessor (74 migrations, seeded) | applied |
| Abort under `lock_timeout` | `P3018`/`55P03`, nothing left behind, re-deploy succeeds |
| Written rollback, run verbatim | schema byte-identical to the predecessor; re-apply clean (re-proven 2026-10-25 and 2026-10-28) |
| Strict drift check | exit 0; a perturbed schema exits 2 |
| Invariants with check 9 | 60/60 on #112's branch; 69/69 with every PR |
| Replica-only triggers | caught by check 9 |
| An upcoming overlap written while the trigger was off | caught by 9c and the preflight |
| An ended overlap, one booking still running | not counted, and not blocking a link (DEF-35) |
| Preflight | read-only pin, counts only, no identifier in the output; an appended write is refused |
| `migrate.yml` order | the preflight runs before the apply (workflow test) |
| Concurrency | two connections, one practitioner: exactly one booking |
| Every booking path | 409 `slot_taken`, never a 500, and no trace written |
| Rollback doc rule (#124) | #112's header passes; a second transaction or a stray step fails |

The **production preflight has not been run**, and must not be run by this
work. It is the operator's step before the merge (§9, runbook 1). Expected
output, exactly:

```
=== practitioner double-booking preflight (counts only) ===
0
<n>
0|0|0|PASS: nobody is booked in two places
```

The second line is the count of guard triggers: 0 before the migration, 2
after. The third is the number of practitioners with several staff rows, for
context only.

## 9. Release plan for the next gate

### Merge order

| Step | PR | Notes |
|---|---|---|
| 1 | #121 | First, so every later push CI checks the code |
| 2 | #111 | **Security hotfix: its own release window.** Runtime upgrade of `next` and the Sentry SDK. Smoke tests after the deploy (runbook 3) |
| 3 | #125 | Auth and tenancy hardening, no migration |
| 4 | #127 | Reset reliability, no migration |
| 5 | #119 | Before or with #118 |
| 6 | #118 | Changes live schedules; merge before any soak |
| 7 | #113 | **Before #117** |
| 8 | #122 | **The merge runs the verifier against production** (read-only). Runbook 2 first |
| 9 | #112 | **The merge is the migration.** Runbook 1 first; after it, `migrate.yml` must show the migration applied, no drift, and check 9 ok |
| 10 | #114 | — |
| 11 | #126 | Stacked on #114. Publishes `/privacy` draft-2 (still a draft) |
| 12 | #115 | The first housekeeping run deletes `cancelled` rows older than 30 days |
| 13 | #116 | — |
| 14 | #117 | Contains #113; after step 7 its diff is its own changes |
| 15 | #123 | Test-only |
| 16 | #124 | Its rule then applies to every new migration |
| 17 | #120 | Docs |

Before each merge, update the branch, then read that head's own CI run on the
then-current `main`. After each merge, read the push run on the merge commit
(attempt 1, from the unfiltered listing).

### Branch protection (owner setting; not changed here)

Apply the five-check rule in `docs/release-state.md` §4 (added by #121)
**once #111 is on `main`**: `Secret scanning`, `Dependency audit (high and critical)`, `Lint,
type-check, test, and build`, `Browser, mobile, and accessibility suite`,
`Pull request body`. Before #111 merges, the audit fails for every other pull
request, so requiring it earlier blocks them all. `tests/workflow-safety.test.ts`
keeps the documented list equal to the jobs the pull-request workflows run.

### Production UAT gates

Synthetic UAT organisation and its fixtures only. Never a customer, and never a
production membership changed for a test. Pair every crafted refusal with a
crafted allowed call.

| PR | Gate |
|---|---|
| #111 | `/api/health` 200 `{"ok":true}`; sign-in; a booking; a Server Action (a settings save) |
| #112 | Link a provider at two locations. Book A at 10:00; B at 10:30 → 409; B at 11:00 → OK. The picker at B hides 10:00 |
| #113 | The provider and front desk see settings read-only, and a crafted save is refused. The owner's lead-time change appears in `/audit` with `previous` |
| #114 | Waitlist add and remove audited. A cancellation audits one `notified` row per entry. Deleting a UAT customer with an entry audits that entry once |
| #115 | **Blocked until a test mailbox is designated.** Then one working email per resend, and `outbox-dead-letters` stays green |
| #116 | FD-A sees only location A; a hand-set cookie for B still shows A; FD-0 sees "No location assigned" |
| #117 | A crafted refused action answers 200 with `{ ok: false, code }` and changes nothing. Card payment still reaches the gateway |
| #118 | Natural runs over 7 days (runbook 5). If it fails, **do not raise thresholds** (§11) |
| #119 | The monitor stops failing on an empty window; #90 stays open |
| #122 | The merge run's verifier passes |
| #125 | Each cron route answers 401 to a wrong bearer; the scheduled runs keep succeeding |
| #126 | Redact a UAT customer with a waitlist entry and a delivered reminder: entry gone and audited, record cleared, no name in `/audit` or the bell; adding them to the waitlist or booking them is refused |
| #127 | A reset link works once; a second use is refused cleanly |

### Operator runbooks

1. **#112 preflight (before merging #112; read-only).** From a checkout of
   #112's head, with the production session URL read without echo:
   `read -rs PGURL && export PGURL`, then
   `psql "$PGURL" -X -q -v ON_ERROR_STOP=1 -At -F '|' -f scripts/practitioner-double-booking-preflight.sql`,
   then `unset PGURL`. Not in the Supabase SQL editor: the script uses psql
   meta-commands, and its read-only pin binds later transactions. Expected
   output is in §8. A non-zero first count in the last line is a real person
   booked in two places: resolve it with the organisation first, or check 9c
   fails after the apply.
2. **#122 pre-check (before merging #122; read-only).** As the role
   `migrate.yml` uses, run
   `SELECT setting, source FROM pg_settings WHERE name = 'session_replication_role';`.
   Expected `origin` with source `default` or `configuration file`. Anything
   else, and check 2b fails as unverified, which is intended: investigate the
   default first.
3. **After each deploy.**
   - The production deployment id changes to the merge commit's.
   - `/api/health` returns 200 `{"ok":true}` on both canonical hosts.
   - The next scheduled monitor run stays at its previous result: today, only
     `reminders-missed NOT VERIFIED`, which #119 turns from a failure into
     "not verified".
   - For #122 and #112, the `migrate.yml` run shows the migration status, no
     drift, and `=== production invariants: ALL CHECKS PASSED ===`.
4. **Ending #90.** Only on a natural run that measured a real owed-and-delivered
   reminder.
   - Owed-and-delivered means a UAT appointment inside the lead window, for a
     UAT customer whose channel delivers, after #119 is deployed.
   - The canonical automation closes #90. **Never close it by hand.**
   - For email, this is blocked on the test mailbox.
5. **Observing the scheduler (#118).** Over 7 days of natural runs
   (`gh run list --workflow production-monitor.yml --event schedule`, and the
   same for `cron.yml`), all of these must hold:
   - the monitor runs at least 15 times a day, with a largest gap under 5 h;
   - fewer than 5 % of 24 h windows contain a gap over 6 h;
   - the reminders and housekeeping union has a largest gap under 6 h;
   - no scheduled monitor run was cancelled.
6. **Sentry and monitoring evidence.**
   - The scheduled `sentry-reverify.yml` stays green.
   - At a soak start, `release-verify-and-soak.yml` re-proves server and browser
     receipt on the new deployment.
7. **Rollback conditions.** Roll back on any of these:
   - health not 200;
   - production 5xx;
   - a monitor check that was green going red;
   - a verifier failure after a merge.

   How: revert the merge commit, which redeploys the previous code.

   For #112, roll back the application first, then the migration with the
   rollback in its header. That step is a production SQL change, so the owner
   decides it.
8. **The lead-time query (read-only, no PII).**
   `SELECT count(*) FROM organizations WHERE reminder_lead_hours < 10;`
   Record the count and the decision (§11).

### Before a soak can certify the new release

- Every merge done; the final SHA served on both canonical hosts.
- #118's delivery criteria met on natural runs.
- #90 closed by the canonical automation on a real owed-and-delivered reminder.
  No other `ops-incident` open.
- Sentry verified by `release-verify-and-soak.yml`.
- The lead-time query answered and the decision recorded.
- `fdf6559`'s certification (#110) remains the record for `fdf6559` only.

## 10. Release gates

| Gate | Status | Evidence | Remaining action | Responsible |
|---|---|---|---|---|
| Code checks in CI, every PR head | **PASS** | §3 | re-read on the then-current `main` before each merge | release owner |
| Browser suite in CI, every PR head | **PASS** | §3 | as above | release owner |
| Secret scanning | **PASS** | CI gitleaks per PR; local gitleaks, full history, 0 | enable GitHub secret scanning and push protection (DEF-20) | owner |
| Dependency audit on `main` | **FAIL** | 2 critical, 5 high, 3 moderate (§1) | merge #111 in its own window | owner |
| Dependency audit, #111 and the combined tree | **PASS** | 0 at every severity | — | — |
| The `braces` advisory | **NOT APPLICABLE** | withdrawn 2026-10-23 | — | — |
| Combined tree: unit, integration, invariants, build, browser | **PASS** (local) | §4 | — | — |
| Migration #112, local validation | **PASS** | §8 | — | — |
| Migration #112, production preflight | **NOT RUN** | — | runbook 1, before merging #112 | operator |
| #122 production pre-check | **NOT RUN** | — | runbook 2, before merging #122 | operator |
| Production migration and post-deploy verification | **NOT RUN** | — | at the gate; runbook 3 | owner, operator |
| Incident #90 | **BLOCKED** | open since 2026-10-05 | #119 deployed, a real owed-and-delivered reminder, a test mailbox for email | owner, operator |
| Scheduler validation (#118) | **NOT RUN** | measurable only after the merge | runbook 5 | operator |
| Sentry | **PASS** for the current deployment | `40581604800`, 2026-10-27 | re-verify at the soak start | automation |
| Lead time under 10 hours | **NOT RUN** | production read | runbook 8 | operator |
| Codex review, latest heads | **PARTIAL** | every PR reviewed at least once and every finding fixed (DEF-02–04, 24–35); re-reviews of the newest heads pending or failing on Codex's side (PR comments) | read the results before each merge | release owner |
| Legal approval | **BLOCKED** | `docs/launch-human-decisions.md` §1 | the legal reviewer's decisions, including erasure (§7) | legal reviewer, operator |
| Operator identity | **BLOCKED** | same, §2 | supply the five fields | operator |
| Test mailbox | **BLOCKED** | same, §3 | nominate one | release owner |
| Branch protection | **BLOCKED** (owner setting) | rule documented in `docs/release-state.md` §4 (#121) | apply after #111 | owner |
| Soak of the new release | **NOT RUN** | — | after every merge | automation, owner |
| Production unchanged during this work | **PASS** | deployment `6769046032` / `fdf6559` since 2026-09-30 | — | — |

## 11. Owner decisions

1. **Release #111 now, as a security hotfix.** The Server Actions DoS applies to
   this app. Its own window, before the rest.
2. **Branch protection**: the five-check rule, after #111 (§9).
3. **Repository security settings** (DEF-20): enable Dependabot alerts, secret
   scanning and push protection. Optionally pin GitHub-owned actions by SHA
   (DEF-21).
4. **Erasure scope**, with the legal reviewer: appointment notes, treatment
   history, notification retention, audit rows written before #126 (§7).
5. **Public booking identity and consent** (DEF-11), and **the payment
   description** (DEF-10).
6. **RLS-only queries** (DEF-08): accept as a defence-in-depth backlog, or
   schedule a sweep.
7. **If #118 under-delivers:** Supabase `pg_cron` + `pg_net` (recommended for
   the reminders tick), Vercel Cron, or an external dispatcher (but that turns
   runs into `workflow_dispatch`, which this project excludes from evidence).
8. **Positive reminder evidence in every soak window** (after #119): if wanted,
   add it as an explicit soak gate.
9. **Waitlist notifications from UI cancellations** (F-5).
10. **Short lead times** (F-7), if the gate query is non-zero.

## 12. How the evidence was produced, and what it does not establish

- Local PostgreSQL only: the dev database for unit and integration runs, a
  fresh seeded UTC database for the invariants suite, and a separate disposable
  database for the browser suite. Every URL was checked to be loopback (and a
  `*test` database where required), and no credential was printed. The
  cluster-wide `ALTER SYSTEM` case ran locally only with nothing else connected,
  and the server's value was confirmed restored.
- True exit codes throughout. Every control added was switched off and the red
  tests counted (in each PR description). Races were run for real: a second
  connection holds a lock or a write open until the path under test is seen
  waiting on it.
- Production was read only through GitHub's API (deployments, workflow runs,
  issues, settings). Nothing was dispatched, merged, deployed or migrated, and
  no production database was queried.
- **Correction to the 2026-10-18 report:** it said Codex had not reviewed
  #116–#124. Codex reviewed #122, #123 and #124 on 2026-10-18 at 17:47–17:58Z.
  Those findings were answered and fixed on 2026-10-24 (DEF-02–04).
- **Not established:** anything in production. Every production gate in §10 is
  open. The browser suites ran against CI-style seeded data, not production
  data.
