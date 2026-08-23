# Phase 16 — September integration checklist

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
