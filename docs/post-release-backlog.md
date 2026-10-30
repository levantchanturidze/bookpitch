# Post-release backlog: round record and release plan

**Status on 2026-10-31: 21 pull requests open (#111–#131), none merged. New
release gate NOT STARTED.** Production is the certified release `fdf6559`,
unchanged throughout this work.

The decisions only a person can make before launch are in
`docs/launch-human-decisions.md`. The privacy decisions for the owner and the
legal reviewer are in `docs/privacy-decisions.md`. Current production state
lives in `docs/release-state.md`. The legal review's open items are in
`docs/legal-review-checklist.md`. The tenant-isolation audit (DEF-08) is
`docs/tenant-isolation-audit.md` on #128.

**The 2026-10-31 round** (§0) re-verified every PR against the brief's defect
list. It opened #128 to #131, and added fixes or tests to #122, #123, #124,
#126 and #127. It found DEF-40 to DEF-52, and merged twenty heads together
locally: unit, invariants, build, browser and audit. #131 was opened after
that rehearsal.

> **Merging any of these is a production change.** Vercel deploys every push to
> `main`, so every merge gives production a new deployment id, moving it off the
> certified deployment. Two merges also run `migrate.yml` against production:
> #112 applies its migration and changes the invariant verifier, and #122
> changes the verifier. The next release gate decides when (§9).

## 0. The 2026-10-31 round

| Change | PR | Head | Evidence |
|---|---|---|---|
| **DEF-40:** the authorisation resolvers (`lib/rbac/scope.ts`) loaded the row by id alone, and RLS alone made their `organizationId` assertion true. With RLS taken away, organisation A's owner cancelled B's appointment (200) and deleted B's waitlist entry (200). Now every resolver names the organisation. Plus the DEF-08 audit: inventory, review of all 56 bypass queries, ratchet test | **#128 (new)** | `4fb350c` | 4 red with the resolvers reverted; ratchet 3 ways; CI `41137370607` |
| **DEF-41:** a suspended or archived organisation's public widget took bookings. Now it refuses exactly what `can()` refuses. **DEF-48** (Codex): the status is re-checked `FOR SHARE` in the write transaction | **#129 (new)** | `13df39b` | 5 statuses × 3 paths agree with `can()`; 3 red reverted; race red without the re-check; CI `41133255069` |
| **F-5:** a scheduler cancellation now runs the waitlist fan-out the API runs (one function). **A behaviour change for the owner to accept** | **#130 (new, stacked on #114)** | `af6ee00` | 4 tests; perturbations 2/1/1; CI `41130954291` |
| **DEF-42:** public booking raced an erasure and attached to the redacted customer | #126 | `e9baeb5` | 2 red on the original; 2 red without `FOR SHARE`; CI `41129436990` |
| **DEF-44:** the rollback rule accepted `END;`, `COMMIT AND CHAIN;`, `ROLLBACK;`, `ABORT;`, `ROLLBACK TO SAVEPOINT` and psql meta-commands inside the transaction. Also, the `DO`-block fixtures never contained `$$` (a `String.replace` pitfall) | #124 | `bd2c35f` | 1 red per check removed; #112 with `END;` injected refused; CI `41132514531` |
| **DEF-49:** check 2b's precedence levels 2 and 4 were untested | #122 | `433d9e6` | levels swapped: 1 red (the existing 59 all passed); CI `41131599030` |
| **DEF-50:** a never-issued reset link was not tested against a live one | #127 | `08f747b` | token filter removed: 1 red; CI `41132971390` |
| **DEF-43:** a decline or revoke racing an accept overwrote the accepted transfer. **DEF-52:** `nominateTransfer`'s notification sat in a plain catch inside the transaction, so a failure silently rolled back the nomination itself | **#131 (new)** | `91f6a88` | both reproduced on `main`'s code, then fixed; CI `41137046677` |
| A production-code guard against swallowed DB errors in transactions (found DEF-52; its first version missed #114's own defect, fixed before commit) | #123 | `de7f9a4` | emptied allowlist reports exactly the 3 known instances; CI `41137186689` |

Verified with no new defect (details in the PR threads): #111's audit is 0 (re-run 2026-10-28 and on the combined lockfile 2026-10-30); #125's constant-time and authorisation fixes are complete; #114, #115, #112 and #121 match their claims. Recorded, not changed: DEF-45, DEF-46, DEF-51 (§5), and the workflow hardening items (§6).

**Codex:** every re-review requested on 2026-10-30T21:51–21:54Z was refused with "You have reached your Codex usage limits for code reviews" (§10).

## 1. Baseline (re-observed 2026-10-30, read-only)

| Fact | Observed |
|---|---|
| `origin/main` | `fdf6559891788a41b545ae5823de89b5f3a1689f`, unchanged since 2026-09-30 |
| Production deployment | `6769046032`, sha `fdf6559`, created 2026-09-30T20:09:21Z |
| Certification | soak #110, closed 2026-10-03, certifying `fdf6559` / `6769046032`. Untouched |
| Production monitor | run `41130853869` (2026-10-30T21:24Z, scheduled): 26/29 checks passed. The one failure is `reminders-missed NOT VERIFIED`: no appointment was owed a reminder in 48 h. Same state since 2026-10-18 |
| Open `ops-incident` | #90 only (reopened 2026-10-05 by the empty window; see #119) |
| Sentry re-verification | run `41127370297`, 2026-10-30T20:58Z, scheduled: success |
| Backups | run `41021710277`, 2026-10-30T07:42Z, scheduled: success. Restore drill last green `37193588304`, 2026-10-04 |
| Branch protection on `main` | none (`404 Branch not protected`) |
| Repository security settings | Dependabot alerts **disabled**, Dependabot security updates disabled, secret scanning disabled, push protection disabled (DEF-20) |
| `npm audit` on `main`'s lockfile (2026-10-28T16:41Z) | **2 critical, 5 high, 3 moderate**, across `next`, `@sentry/nextjs`, `sharp`, `undici`, `zod`, `fast-uri`, `source-map-js`, `vite`, `vitest`, `@vitest/mocker`. All have published fixes; #111 applies them (§6) |

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
| #122 | `fix/verify-trigger-states` | `433d9e6` | The verifier refuses replica-only tenant-isolation triggers and an effective `session_replication_role = replica`, at every level including the server's | — |
| #123 | `test/teardown-failures-visible` | `de7f9a4` | Test teardowns no longer swallow DB errors inside transactions; a static check keeps it that way | — |
| #124 | `docs/migration-rollback-inventory` | `bd2c35f` | Rollback rules and inventory for the 74 applied migrations, plus a test holding new migrations to one complete rollback transaction | — |
| #125 | `fix/auth-tenancy-hardening` | `130956d` | Constant-time bearer checks, push-unsubscribe ownership, send-now's explicit org filter | — |
| #126 | `fix/erasure-minimisation` | `e9baeb5` | Erasure removes waitlist entries and delivery contents, copies the name nowhere, and nothing new can attach to a redacted customer | **stacked on #114** |
| #127 | `fix/db-clock-reset-atomicity` | `08f747b` | Password-reset expiry on the database clock, and a race-free single use | — |
| #128 | `fix/tenant-isolation-audit` | `4fb350c` | The authorisation resolvers name the organisation (DEF-40); the DEF-08 audit, inventory and ratchet | — |
| #129 | `fix/public-booking-org-status` | `13df39b` | A suspended or archived organisation's widget takes no bookings, re-checked under a lock (DEF-41, DEF-48) | — |
| #130 | `feat/waitlist-on-ui-cancel` | `af6ee00` | F-5: a scheduler cancellation notifies the waitlist as the API does. **Behaviour change** | **stacked on #114** |
| #131 | `fix/ownership-transfer-decided-once` | `91f6a88` | An ownership transfer is decided once (DEF-43); a failed nominee notification no longer undoes the nomination (DEF-52) | — |

## 3. CI status at each head

| PR | Head | CI run | Code checks | Browser suite | Secret scan | PR body | Dependency audit |
|---|---|---|---|---|---|---|---|
| #111 | `afb7dd6` | `40104675087` | pass | pass | pass | pass | **pass** |
| #112 | `45ae78d` | `40606473585` | pass | pass | pass | pass | fail |
| #113 | `5846366` | `39152087416` | pass | pass | pass | pass | fail |
| #114 | `3b2251a` | `40143187022` | pass | pass | pass | pass | fail |
| #115 | `dce91e9` | `40604856132` | pass | pass | pass | pass | fail |
| #116 | `12b04d4` | `39152097386` | pass | pass | pass | pass | fail |
| #117 | `461857f` | `39152100259` | pass | pass | pass | pass | fail |
| #118 | `30ae8cc` | `39152102456` | pass | pass | pass | pass | fail |
| #119 | `9a60698` | `39152106466` | pass | pass | pass | pass | fail |
| #121 | `87153fc` | `40142057430` | pass | pass | pass | pass | fail |
| #122 | `433d9e6` | `41131599030` | pass | pass | pass | pass | fail |
| #123 | `de7f9a4` | `41137186689` | pass | pass | pass | pass | fail |
| #124 | `bd2c35f` | `41132514531` | pass | pass | pass | pass | fail |
| #125 | `130956d` | `40139452758` | pass | pass | pass | pass | fail |
| #126 | `e9baeb5` | `41129436990` | pass | pass | pass | pass | fail |
| #127 | `08f747b` | `41132971390` | pass | pass | pass | pass | fail |
| #128 | `4fb350c` | `41137370607` | pass | pass | pass | pass | fail |
| #129 | `13df39b` | `41133255069` | pass | pass | pass | pass | fail |
| #130 | `af6ee00` | `41130954291` | pass | pass | pass | pass | fail |
| #131 | `91f6a88` | `41137046677` | pass | pass | pass | pass | fail |

The audit fails on `main`'s lockfile, which every branch but #111 carries, and
on nothing any of these PRs change. It is red under its own name, and no
exception, allowlist or threshold change is configured. After #111 merges, a CI
re-run on each PR audits the lockfile merged with `main`.

CI runs the invariants suite with nothing skipped, including the cluster-wide
`ALTER SYSTEM` case of check 2b (59 tests in that file on #122's run). #120's
own run is in its CI evidence comment.

## 4. Every PR merged together (local rehearsal, 2026-10-30)

Every open head was merged into a throwaway local branch built from
`origin/main` (`rehearsal/combined-2026-10-31`), never pushed. **No textual
conflict.** The one real conflict, #113 with #117, is resolved inside #117's
branch. The first pass had twenty heads (combined tree `7a2da31`); #131 and the
newer #123 and #128 heads were merged in afterwards (`a0f2024`, all 21).

| Check | Result |
|---|---|
| `npm ci` (real install, #111's lockfile) | exit 0; `next` 16.4.3, `@sentry/nextjs` 10.76.2, `sharp` 0.35.5, `undici` 7.30.1 |
| `npm audit`, every severity | **0** |
| `format:check` / `lint` / `tsc --noEmit`, all 21 | exit 0 / 0 (0 errors, `main`'s 11 warnings) / 0 |
| #112's preflight on both local databases, before the migration | `0` / `0` / `0\|0\|0\|PASS: nobody is booked in two places`, the documented output |
| `npm run test`, 20 heads (`7a2da31`) | **exit 1: 2524 passed, 1 failed, 74 skipped.** The failure is environmental, not from any PR (see below) |
| `npm run test`, all 21 heads, after 23:00 UTC (`a0f2024`) | **not run.** The clean re-run, due after 23:00 UTC, was cut off by a usage limit. Run `npm run test` on the combined tree before relying on it |
| Invariants suite, 75 migrations, cluster-wide cases opted in, nothing else connected | **75/75** (71 before plus #122's 4 new). Afterwards the server read `origin` from `default`, with no role or database defaults left |
| `next build` | exit 0 |
| Browser suite, 20 heads, all 9 projects, disposable database, CI's environment | **266 passed, 3 skipped (269)**; `e2e:check`: all 9 required suites executed |
| Browser suite, all 21 heads, fresh disposable database | **266 passed, 3 skipped (269)**; all 9 required suites executed. The 3 skips are the touch-height check on desktop projects, by design |
| Production swallow scan (#123's new guard) over all 21 | **no instance**: the three known ones are each removed by their PR |
| gitleaks over every commit this round added (redacted) | **0 findings** |
| #112's rollback, run verbatim from its header, on the invariants database | 74 migrations, both triggers gone, schema **byte-identical** to a 74-migration predecessor (`pg_dump -s -O -x`, minus the per-dump `\restrict` key, 4299 lines each). Re-applied cleanly (both triggers back, enabled), then rolled back again: identical again |

**The one failure in the first run, and why it is not a code defect.**
`tests/ops-metrics.test.ts` "reads audit_log partition state" expects the
`audit_log` default partition to be empty. It held one row, written by
`tests/reminder-gap-recovery.test.ts`, which fakes `Date` 25 hours ahead and
runs a reminder tick (lines 378–379, unchanged on `main`). Prisma stamps
`audit_log.at` from the application's clock (`@default(now())`), so the row was
dated 2026-10-31T22:54Z. The **local** database's October partition was created
with `+04` boundaries and ends at 2026-10-31T20:00Z, while November starts at
00:00Z, so the row fell into the four-hour gap. It reproduced on `main`'s code.
It can only happen between 19:00 and 23:00 UTC on 2026-10-30, and CI's fresh
UTC database has no gap. Recorded as DEF-51 for the clock part.

After the runs, #112's migration was rolled back out of both local databases,
ledger row included, and both were verified at 74 migrations; the disposable
browser-suite database was dropped.

The combined diff was reviewed for accidental changes: no skipped, focused or
deleted tests; every changed assertion in an existing test replaced by an
equal or stronger one; no change to `.gitleaks*`, `AGENTS.md`, `CLAUDE.md` or
`.env*`.

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
| DEF-38 | P2 | Migration safety | The rollback rule counted any statement as a reverse step, so `SELECT 1;` beside the ledger delete passed | #124 `029240a` | 3 no-op forms refused, a DO that drops accepted; 1 red with the rule off; #112 with `SELECT 1` in place of its steps fails | — |
| DEF-39 | P2 | Migration safety | DEF-38's fix let a DO block count when its body mentioned a state-changing word, so `RAISE NOTICE 'DROP TABLE'` passed | #124 `8bdae89`: a DO block never counts; the reverse is plain statements | a notice and a real `EXECUTE 'DROP …'` each refused alone, a DO beside a DROP passes; red against DEF-38's rule | — |
| DEF-40 | P2 | Tenancy | The authorisation resolvers loaded one row by id inside `withOrg` and returned a `Resource` asserting the caller's organisation, true only because RLS made it so. Without RLS: A's owner cancelled B's appointment and deleted B's waitlist entry (200 each) | #128 `7e386e0` | `tenant-scope-resolvers` 6; 4 red reverted, both complements pass | — |
| DEF-41 | P2 | Booking, fail-closed | The public widget took bookings, and rendered, for a suspended or archived organisation, whose staff `can()` locks out (CLAUDE.md invariant 2) | #129 `eb1e25d` | 5 statuses × page, POST and `can()` agree; 3 red reverted | — |
| DEF-42 | P2 | Privacy | Public booking matched a customer with a plain read; racing an erasure, it attached the booking and its notes to the redacted customer (DEF-31's gap; DEF-33's harm through the retention sweep) | #126 `e9baeb5` | real interleaving; 2 red original, 2 red without `FOR SHARE` | #114 |
| DEF-43 | P3 | Admin, integrity | `declineTransfer`/`revokeTransfer` check `pending`, then update by id with no status predicate and a Node-clock `decidedAt`; racing an accept, either relabels an accepted ownership transfer (and decline audits a refusal that never happened) | #131 `3b89f07` | real interleaving; both red on `main` | — |
| DEF-44 | P2 | Migration safety | The rollback rule accepted `END;`, `COMMIT AND CHAIN;`, `ROLLBACK;`, `ABORT;`, `ROLLBACK TO SAVEPOINT` and psql meta-commands inside the one transaction. The `DO` fixtures never held `$$` (`String.replace` pitfall) | #124 `bd2c35f` | 1 red per check removed; #112 with `END;` injected refused | — |
| DEF-45 | — | Privacy | Staff can add treatment history to, and type PII back into, a redacted customer; a name restored un-erases the row | — | — | **owner and legal** (`docs/privacy-decisions.md`) |
| DEF-46 | — | Operations | The reminders cron messages customers of suspended and archived organisations | — | — | **owner** (#129's description) |
| DEF-47 | P2 | Tooling | (Codex on #128.) The inventory counted `organizationId` anywhere in a query's arguments, including `select` and SQL projections, as a tenant filter; 15 bypass queries were hidden | #128 `58c8384` | predicate-only; 15 rows reviewed; old classifier 3 red | — |
| DEF-48 | P2 | Booking | (Codex on #129.) The status check ran before the write transaction; a suspension committing in between did not stop the booking | #129 `13df39b` | real interleaving; red without the re-check | — |
| DEF-49 | P3 | Verifier tests | Check 2b's precedence levels 2 (role, every database) and 4 (every role) were implemented but untested | #122 `433d9e6` | levels swapped: 1 red (existing 59 passed); level 4 ignored: 1 red | — |
| DEF-50 | P3 | Auth tests | No case presented a never-issued reset link while a real one was live | #127 `08f747b` | token filter removed: 1 red, nothing else | — |
| DEF-51 | P3 | Audit clock | `audit_log.at` is Prisma's `@default(now())`, filled in by the application, not the database: a test that fakes `Date` +25 h wrote an audit row 25 h ahead. On the local database, whose October partition ends at a `+04` boundary, it fell into the default partition and failed `ops-metrics` between 19:00 and 23:00 UTC on 2026-10-30 (reproduced on `main`'s code). The same mechanism lets a skewed application clock misdate the audit log | **recorded, not changed**; proposal §11 | reproduced on `main` | — |
| DEF-52 | P2 | Admin, integrity | `nominateTransfer` sent the nominee's notification in a plain `try/catch` inside its transaction. A failed statement aborted the transaction and the COMMIT silently rolled back the nomination, while the function returned its id and emailed the nominee. #114's shape, found by #123's new production scan | #131 `91f6a88` | real failing statement; red on `main` | — |

Earlier findings, 2026-10-17 and 10-18, final status: F-1 to F-4, F-6, F-8 to
F-11 and F-13 to F-20 are fixed in their PRs (F-21 became DEF-09 and is fixed
in #126). **F-5**, a UI cancellation does not notify the waitlist: the
documented behaviour (`docs/features-en.md`, "runs on cancel transition") is
implemented in **#130**, a behaviour change for the owner to accept. **F-7**,
lead times under 10 hours against the observed tick gaps: the implemented floor
is `MIN_REMINDER_LEAD_HOURS = 8`, calibrated on a 4 h 40 m gap, and #118's
measurement found 9.9 h. No written rule says 10 h, so nothing was hard-coded.
It needs the production read (runbook 8) and a decision (§11).

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
a SHA).

Re-audited 2026-10-31, with no defect found:
- Every untrusted value reaches a shell through `env:`, never interpolated: PR
  title and body, and every `workflow_dispatch` input.
- The repository's default token permission is `read`.

Hardening, recommended and not changed (none is a defect today):
1. Give `cron.yml` (`permissions: {}`) and `load-test.yml`
   (`contents: read`) an explicit `permissions` block, so they do not depend on
   the repository default.
2. Pass `secrets.APP_URL` and `secrets.CRON_SECRET` to `curl` through `env:`
   in `cron.yml`, not interpolated.
3. Pin GitHub-owned actions by SHA (DEF-21).

`#118` edits `cron.yml`, so 1 and 2 belong after it. Secret scanning: CI's gitleaks passes on every PR, and a local gitleaks
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
| Invariants with check 9 | 60/60 on #112's branch; 71/71 with every PR |
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
| 17 | #128 | Tenancy resolvers and the DEF-08 ratchet. Independent; any time after #121 |
| 18 | #129 | Booking fail-closed. Independent |
| 19 | #130 | Stacked on #114. **Only if the owner accepts F-5's behaviour change** |
| 20 | #131 | Ownership transfer integrity. Independent |
| 21 | #120 | Docs |

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
| #128 | Unchanged behaviour: the scoped-RBAC UAT (owner, branch manager, provider, front desk) still allows and refuses as before. Cross-tenant behaviour without RLS is a test-only condition |
| #129 | Suspend the UAT organisation: its `/book/<slug>` is 404, and a POST is 400 with nothing written. Reactivate: booking works |
| #130 | Cancel a UAT appointment in the scheduler with a matching UAT waitlist entry: the entry is `notified`, audited once, with one "Slot opened" bell. Cancel again: nothing new |
| #131 | Nominate a UAT member as owner, then accept: ownership moves, and a later revoke attempt is refused cleanly |

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

9. **Repository security settings (owner; not done by any agent).** Observed
   2026-10-30 via `GET /repos/…` (read-only): Dependabot security updates,
   secret scanning, push protection and validity checks all `disabled`;
   Dependabot alerts disabled (`/vulnerability-alerts` 404); `main`
   unprotected. The repository is public, so all of these are available at no
   cost. In this order:
   1. **Dependabot alerts:** `gh api -X PUT repos/levantchanturidze/bookpitch/vulnerability-alerts`.
      Verify: the same path with `GET` answers 204.
   2. **Dependabot security updates:** `gh api -X PUT repos/levantchanturidze/bookpitch/automated-security-fixes`.
      Expect PRs for the advisories #111 already fixes; close them in favour of
      #111, or let #111 merge first.
   3. **Secret scanning and push protection:**
      `gh api -X PATCH repos/levantchanturidze/bookpitch -f 'security_and_analysis[secret_scanning][status]=enabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'`.
      Verify: `gh api repos/levantchanturidze/bookpitch --jq .security_and_analysis`
      shows both `enabled`. CI's gitleaks job stays; the two are complementary
      (push protection blocks before the push, gitleaks reviews every PR).
   4. **Branch protection, only once #111 is on `main`:** the five-check rule in
      `docs/release-state.md` §4 (#121). Verify by watching it refuse: open a
      throwaway PR whose `Pull request body` check fails (a closing keyword
      before an issue number), and confirm the merge button is blocked. Then
      close it.

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
| Codex review | **PARTIAL; blocked by Codex's usage limit** | On 2026-10-30, Codex reviewed #128 and #129 on opening; each finding was fixed and answered (DEF-47, DEF-48). Every re-review requested 21:51–21:54Z (#118, #122, #124, #125, #126, #127, #128, #129, #130) was refused: "You have reached your Codex usage limits for code reviews". **Not reviewed at their current heads:** #122, #124, #125, #126, #127, #128, #129. **Never reviewed:** #118, #130. Earlier: 16 of 17 PRs reviewed at least once, and every finding fixed and answered in its thread (DEF-02–04, 24–35, 38–39). Clean at the current code head: #111 (its one finding fixed in #121), #112, #113, #114, #115, #116, #117, #119, #122, #123. Not re-reviewed at the newest code: #124 (its 2026-10-28 reviews found DEF-38 and DEF-39, fixed in `029240a` and `8bdae89`), #126 (in progress), #125 and #127 (reviewed when opened). **#118 has never been reviewed**: its 2026-10-17 run hit Codex's usage limit, later requests stalled, and the last answered "Setup repeatedly failed" (Codex's environment setup, an owner setting) | read the results before each merge; get #118 reviewed | release owner |
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
10. **Short lead times** (F-7). The floor is 8 h, calibrated on a 4 h 40 m
    gap; #118's measurement found a 9.9 h gap. Options:
    - keep 8 h, and rely on #118 meeting runbook 5's criteria;
    - raise the floor (10 h or 12 h) in `lib/messaging/reminder-window.ts`,
      which existing organisations below it keep until they next save;
    - move the reminders tick to `pg_cron` (item 7).

    First, run runbook 8's count.
11. **Accept or decline F-5's behaviour change (#130).** Staff start getting
    "Slot opened" notifications from scheduler cancellations, as the docs say
    they should.
12. **Privacy decisions DEF-10, DEF-11, DEF-12, DEF-13 and DEF-45**, with the
    legal reviewer: options, consequences and a recommendation for each are
    in `docs/privacy-decisions.md`.
13. **Reminders for suspended or archived organisations** (DEF-46). Options are
    in #129's description.
14. **Schedule the DEF-08 sweep, or accept RLS as the enforcer** for the 98
    RLS-only queries. RLS is verified on every migration run; the proposal is
    `docs/tenant-isolation-audit.md` §7 (#128).
15. **The audit log's clock** (DEF-51). Make `audit_log.at` a database
    default (`@default(dbgenerated("now()"))`, no migration needed if the
    column default is already `now()`; to be confirmed with
    `prisma migrate diff`), so evidence timestamps come from one clock.
    Also, once and read-only, check that production's `audit_log` partitions
    are contiguous.
16. **Codex's usage limit.** Every re-review this round was refused. Raise
    the limit, or name another independent reviewer for #118, #130 and the
    seven PRs whose heads moved (§10).

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
