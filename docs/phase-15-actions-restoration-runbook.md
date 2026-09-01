# Phase 15 — GitHub Actions restoration runbook

> **Executed 2026-09-01. Outcome: step 1 passed, steps 2 onward blocked.**
> Actions billing was restored between 2026-08-31T20:55Z and 2026-09-01T00:05Z
> and every run since executes real steps. The soak did **not** start, because
> production had lost its database in the meantime and no monitor run can be
> fully successful while that is true. The frozen baseline below no longer
> matches reality — read the diff table under "What was actually found" before
> using this runbook. Full record:
> [`docs/phase-17-september-release-ledger.md`](./phase-17-september-release-ledger.md).

For the day GitHub Actions is billable again (expected ~2026-09-01). Until then
Phase 15 is frozen and the mandatory 24-hour soak has **not** started.

## Frozen baseline — verify before anything else

| | |
|---|---|
| `origin/main` | `5c8fb77353869d29cc8378f7a83e6d23a75e55ef` |
| Production deployment | `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG` |
| Deployment SHA | `5c8fb77` (ref `main`) |
| Ready at | 2026-08-22T18:32:42Z |
| `FIELD_ENCRYPTION_KEY` | `prod-v1:…`, Production only, set 2026-08-22T18:30:28Z |
| `AUDIT_DIGEST_ENABLED` | absent — digest paused |
| Production DB | 62 migrations, 0 ciphertext rows, 0 outbox rows |

If any of these differ, stop and reconcile before starting the soak. A change to
the runtime deployment or to Production configuration **restarts the 24-hour
clock from that change**.

## Steps

### 1. Prove Actions actually runs

Billing failures do not fail a step — the job never starts. A run that "failed"
with `steps=0` is a billing symptom, not a test result.

```bash
gh workflow run production-monitor.yml -f alerts=off
sleep 45
gh run list --workflow=production-monitor.yml --limit 1 --json databaseId,conclusion
gh api repos/levantchanturidze/bookpitch/actions/runs/<id>/jobs \
  --jq '.jobs[] | "\(.name) steps=\(.steps|length) concl=\(.conclusion)"'
```

**Gate: `steps > 0`.** Anything else means billing is still blocked. Do not
proceed, and do not interpret the result as a product signal.

### 2. Re-run full CI on the frozen SHA

```bash
gh workflow run ci.yml --ref main
gh run watch
```

Required to be green on `5c8fb77`: *Lint, type-check, test, and build* ·
*Browser, mobile, and accessibility suite* · *Secret scanning*.

Local runs from the holding period do **not** substitute for this.

### 3. Run the production monitor for real

```bash
gh workflow run production-monitor.yml
gh run watch
```

Confirm in the run log:

- `deployment-reachable` names `5c8fb77` and the alias resolves to
  `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG`;
- **`PASS production-config-invalid`** — this is the whole point. It was the only
  FAIL before, at "security env vars set but malformed: 1". The corrected
  `FIELD_ENCRYPTION_KEY` should take that to zero;
- `PAUSE audit-digest-stalled — DISABLED BY CONFIGURATION` (expected, counted
  separately from PASS);
- ciphertext totals still 0; outbox pending/dead/stale still 0.

Expected shape: **18/19 pass, 1 paused, 0 fail.**

### 4. If `production-config-invalid` still fails

The count does not name the variable (by design — names never leave the server).
The four candidates are `AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`,
`RATE_LIMIT_HMAC_KEY`, `EMAIL_PRIVACY_HMAC_KEY`, validated by
`SECURITY_ENV_VALIDATORS` in `lib/ops-metrics.ts`.

`FIELD_ENCRYPTION_KEY` was proven to round-trip through the real
`lib/crypto.ts` parser before it was written, so suspect the other three first.
Do **not** rewrite the field key to "try something" — it is escrowed, and
rewriting it without cause is an unaudited rotation.

### 5. Let incident #26 close itself

`#26 [ops] A required secret is set but structurally unusable` is open and is a
true positive. The monitor closes its own incidents when the condition clears.

**Do not close it by hand.** A hand-closed incident proves nothing and destroys
the recovery signal.

### 6. Start the official soak

Start only when: CI green on `5c8fb77`; every required non-paused monitor check
passing; digest still explicitly paused; no email sent; no production write.

- **T0** = the timestamp of the first fully successful post-restoration monitor run.
- **T0 + 24h** = soak end.
- **Do not backdate T0** to the deployment's Ready time. The deployment has been
  up since 2026-08-22T18:32:42Z, but no scheduled monitor observed it. Unobserved
  uptime is not soak evidence.
- Record honestly which scheduled 30-minute slots ran and which were skipped.

### 7. Only then, Phase 16

Keep `agent/phase-16-prepilot-product-refinement` unmerged for the whole Phase 15
soak. Phase 16 changes payment and messaging fail-closed behaviour, patient and
scheduler data loading, security-sensitive database-time handling, RBAC
permission state, and it carries one database migration — so it needs its own
window, and its evidence must never be combined with Phase 15's.

The order is not negotiable:

1. Phase 15 CI, the production monitor and the full 24-hour soak close first.
2. Update/rebase Phase 16 onto the resulting `main`
   (`git rebase main` — never `reset --hard`, never force-push shared history).
3. Rerun the **complete** Phase 16 verification matrix locally on the rebased tree.
4. Push Phase 16 and open its PR — only once GitHub Actions is restored.
5. Merge only when every required check is green on the **exact head SHA**.
6. Migration 63 (`20260823000001_revoke_marketing_client_contact`) runs through
   the established migration workflow, triggered by the Phase 16 merge.
7. **Do not execute migration 63 against Production by hand.** Not with `psql`,
   not with `prisma migrate deploy` from a laptop.
8. Verify afterwards: `prisma migrate status` shows 63 applied, drift detection
   reports no difference, MARKETING holds exactly `report.own` and
   `report.branch`, and the application deployment that expects that state is
   the one actually serving traffic.
9. If the migration or the application deployment fails, **do not bypass and do
   not patch Production by hand.** Roll back through the same workflow and
   diagnose from the failed run.

Ordering safety is already proven locally: `ROLE_PERMISSION_DENIALS` refuses
MARKETING's patient-contact permissions in code, so a new application running
against a database that still holds the old row denies access anyway. The
migration makes the state correct; the code makes the order irrelevant. That is
belt-and-braces, not a licence to skip step 8.

10. Start a **new** Phase 16 post-deployment monitoring window sized to those
    changes. Do not reuse or merge Phase 15's soak evidence.

---

## What was actually found, 2026-09-01

| Baseline row | Runbook said | Found |
|---|---|---|
| `origin/main` | `5c8fb77` | `dae46ac` — three schedule commits whose net tree change is empty |
| Production deployment | `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG` | `dpl_92gL3DZr6kZLomHK3C1fukxd6F1r` |
| `FIELD_ENCRYPTION_KEY` | `prod-v1:…` set 2026-08-22 | present; **structure not verifiable** — Vercel marks it Sensitive, and the only validator is the running application |
| Production DB | 62 migrations, 0 ciphertext, 0 outbox rows | **unreachable — the Supabase project no longer exists** |

### Step outcomes

1. **Prove Actions actually runs** — **PASS.** Production monitor run
   `33455049387` executed 5 steps including checkout; scheduled cron run
   `33453316896` executed 3. The zero-step signature is gone.
2. **Rerun CI on the frozen SHA** — **superseded.** `dae46ac`'s tree is
   identical to `5c8fb77`; CI ran on the integration branch, which contains
   both.
3. **Prove the encryption-key incident resolved** — **NOT POSSIBLE.**
   `/api/health/ops` returns 503 without a database, so
   `production-config-invalid` is not evaluated at all. Incident #26 was
   auto-closed by exactly that blindness rather than by a recovery; the closing
   behaviour is fixed in `e913f83` and the underlying condition is recorded as
   `NOT VERIFIED`.
4. **Start the 24-hour soak** — **NOT STARTED.** The clock starts at the first
   fully successful monitor run. There has not been one: four of ten checks
   fail, all from a single external cause.

The soak cannot begin until the database is restored. When it is, restart from
step 1 of this runbook: the restore is itself a production configuration change
and resets the clock.
