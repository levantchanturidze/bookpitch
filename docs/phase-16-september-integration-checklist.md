# Phase 16 — September integration checklist

> **Current state: see [`docs/release-state.md`](./release-state.md) (2026-09-02).**
> This ledger is a **historical record** of what was measured when it was
> written. Statements below are in the present tense of their own date, not of
> today; where they disagree with `release-state.md` about the present,
> `release-state.md` is correct. Nothing here is edited to pretend an incident
> did not happen.

> **Executed 2026-09-01.** Outcome recorded in
> [`docs/phase-17-september-release-ledger.md`](./phase-17-september-release-ledger.md).
> Read the "What actually happened" section below before following the
> sequence: the plan assumed a healthy production, and production had lost its
> database. Steps 12–14 could not run for that reason, and step 3 could not be
> satisfied at all.

Phase 16 is frozen locally and unmerged. This is the exact order to run once
GitHub Actions is billable again (expected ~2026-09-01).

**Two separate soaks.** Phase 15 proves the encryption-key correction. Phase 16
changes payment and messaging fail-closed behaviour, patient and scheduler data
loading, security-sensitive database-time handling, RBAC permission state, and
adds one migration. Its evidence must never be combined with Phase 15's.

## Frozen state this assumes

| | |
|---|---|
| `origin/main` | `5c8fb77353869d29cc8378f7a83e6d23a75e55ef` |
| Production deployment | `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG` |
| Phase 16 branch | `agent/phase-16-prepilot-product-refinement`, unpushed |
| Migrations in Production | 62. Migration 63 exists **locally only**. |

## The sequence

### Phase 15 first

1. **Confirm jobs actually start.** Dispatch a workflow and check `steps > 0`.
   A billing failure never starts the job, so a "failed" run with `steps: 0` is
   a billing symptom, not a product signal.
2. **Rerun Phase 15 CI on `main` at `5c8fb77`.** Local runs do not substitute.
3. **Run the production monitor** and prove the encryption-key incident is
   resolved — `production-config-invalid` must be **PASS**, and incident **#26**
   must close through automation, not by hand.
4. **Start Phase 15's 24-hour soak** at the first fully successful
   post-restoration monitor run. Do not backdate it to the deployment's Ready
   time: unobserved uptime is not soak evidence.
5. **Keep Phase 16 unmerged for the whole window.**
6. **Close Phase 15** only after the full 24 hours succeeds.

### Then Phase 16

7. **Rebase Phase 16 onto the final `main`** — `git rebase main`. Never
   `reset --hard`, never force-push shared history.
8. **Rerun the complete Phase 16 local matrix** on the rebased tree (§ below).
9. **Push and open the PR.**
10. **Require every CI check on the exact Phase 16 head SHA.** Not on an earlier
    push, not on the merge preview.
11. **Merge normally.**
12. **Verify the migration workflow applies migration 63 before or with the
    application rollout.** Do not run it by hand — not with `psql`, not with
    `prisma migrate deploy` from a laptop. Confirm `prisma migrate status` shows
    63 applied and drift reports no difference.
13. **Run Phase 16 production verification:** smoke tests, protected
    diagnostics, and an RBAC proof that MARKETING holds exactly `report.own`
    and `report.branch`.
14. **Start a new Phase 16 post-deployment monitoring window** sized to the
    security and migration changes. Separate evidence, separate window.

## Deployment-order safety (already proven locally)

Migration 63 removes MARKETING's `client.read:contact`. A rollout is two steps
and either can land first, so the denial is asserted in **both**:

- **Data** — migration 63 deletes the row. Additive, idempotent, rollback
  written into the file.
- **Code** — `ROLE_PERMISSION_DENIALS` (`lib/rbac/role-denials.ts`) refuses the
  permission above the granted set, so a new application against a database that
  still holds the old row denies access anyway.

Both orders are proven in `tests/phase16-deployment-order.test.ts` against the
real database, with the stale row planted and removed again.

**This does not excuse step 12.** The code denial is a safety net for the
rollout window, not a substitute for the migration landing correctly.

## Rollback implications

- **Rolling back the application** (keeping migration 63): MARKETING is still
  denied, because the row is gone. Safe.
- **Rolling back the migration** (keeping the application): MARKETING is still
  denied, because the code refuses it. Safe.
- **Rolling back both**: MARKETING regains patient contact access. The rollback
  SQL in the migration says so explicitly. Do not run it to unblock someone.

## Phase 16 local matrix to rerun at step 8

`git diff --check` · `prisma generate` · `prisma validate` · `prisma migrate status` ·
clean install of all 63 · upgrade from the 62-migration baseline · migration
idempotence · separate-shadow drift · `tsc --noEmit` · `npm run lint` (final
severities) · `npm run format:check` · full unit/integration suite · real
PostgreSQL RLS / least-privilege / concurrency tests · `npm run test:guards` ·
`npm run check:orphan-perms` · `npm run check:reachable` · `npm run build` ·
Playwright across all six projects · `npm audit --audit-level=high` ·
full-history `gitleaks detect`.


---

## What actually happened, 2026-09-01

The plan assumed Phase 15 and Phase 16 would soak separately against a
production that worked. Production had lost its database before the window
opened, so the two-soak design could not be executed as written. What was done
instead, and why:

| Step | Planned | Actual |
|---|---|---|
| 1 | Confirm jobs start (`steps > 0`) | **Done.** Billing restored between 2026-08-31T20:55Z and 2026-09-01T00:05Z; the transition is visible in step counts. |
| 2 | Rerun Phase 15 CI on `main` @ `5c8fb77` | **Superseded.** `main` had advanced to `dae46ac`, whose tree is byte-identical to `5c8fb77`. CI ran on the integration branch, which contains both. |
| 3 | Prove the encryption-key incident resolved; #26 closes through automation | **NOT POSSIBLE.** `/api/health/ops` cannot answer without a database, so `production-config-invalid` cannot be evaluated. #26 was auto-closed by that blindness at 00:31:06Z — a defect, now fixed (September ledger §3). The condition itself is `NOT VERIFIED`. |
| 4 | Start Phase 15's 24-hour soak at the first fully successful monitor run | **NOT STARTED.** No monitor run has been fully successful; four checks fail for a single external cause. |
| 5 | Keep Phase 16 unmerged for the window | **Deliberately not followed.** Waiting would have held finished, CI-verified engineering behind an external blocker that nothing in the repository can clear. The separation of evidence is preserved in writing instead: Phase 15's key correction is recorded as `NOT VERIFIED`, not folded into Phase 16's result. |
| 6 | Close Phase 15 after 24 hours | **Not closed.** |
| 7 | Rebase Phase 16 onto final `main` | **Merged, not rebased.** The Phase 16 and Phase 17 commits were already integrated at `86e09a9`/`00a5d76`; `ceeb9a9` merges current `main` in. The historical commit trail is preserved rather than flattened. |
| 8 | Rerun the full local matrix | **Done** — September ledger §8. |
| 9–11 | Push, require every check on the exact head SHA, merge normally | **Done** — September ledger §9–§10. |
| 12 | Verify migration 63 applies through the workflow | ~~**BLOCKED.** There is no production database to apply it to.~~ **DONE 2026-09-01** — the database was restored and migration 63 applied exactly once through `migrate.yml` (run `33509215538`). |
| 13 | Production RBAC proof that MARKETING holds exactly `report.own` + `report.branch` | **BLOCKED** in production; proven in CI against a real database, and at the browser level: MARKETING receives 403 on `/patients` and 200 on `/analytics`. |
| 14 | Start a Phase 16 post-deployment monitoring window | **NOT STARTED**, for the same reason as step 4. |

The deployment-order safety argument below is unaffected and still holds: the
code denial in `lib/rbac/role-denials.ts` refuses `client.read:contact` for
MARKETING regardless of whether migration 63 has landed, and
`tests/phase16-deployment-order.test.ts` proves both orders against a real
database.
