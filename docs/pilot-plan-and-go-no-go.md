# Pilot plan and go/no-go decision

## Recommendation

# NO-GO (2026-09-01) — production has no database

**Superseding the R-16 recommendation below.** The Supabase project behind
production no longer exists (R-20): `NXDOMAIN` on `db.<ref>.supabase.co`, and
`FATAL: (ENOTFOUND) tenant/user … not found` from both poolers on both ports.
Every DB-backed route answers 500 or 503. No organisation can be onboarded,
no pilot can start, and R-16 below cannot even be evaluated — the only
validator for it is an endpoint that needs the database.

The data is recoverable: the 2026-08-22 encrypted backup restored cleanly in
drill run `33491958258`, giving an RPO of roughly ten days for this incident
rather than the ~24 hours R-09 assumes. The artifact expires around 2026-09-26.

Restore first (`docs/operations.md` §6), then re-evaluate everything below —
including R-16, which must be re-checked before anything else.

---

## Earlier recommendation, 2026-08 — retained for the record

# NO-GO (until R-16 is corrected), then CONDITIONAL GO

**A P0 configuration defect was found in production during this phase
(R-16).** `FIELD_ENCRYPTION_KEY` is set without its `<key-id>:` prefix, so
every `encryptField()` call throws — signup, patient clinical fields and MFA
enrolment all return 500 right now. While that stands, the answer is `NO-GO`,
because no organisation can be onboarded at all.

It is a one-line configuration correction. Once made and verified, the
recommendation becomes **CONDITIONAL GO**, conditional on one email item —
receiving and inspecting a real message (R-04) — plus legal review.

**Correction:** an earlier revision listed three email blockers on the basis
that the sending domain was unverified. That was wrong; the domain is verified
(DKIM, SPF and bounce MX are all published under `send.bookpitch.ge`). See
`docs/email-dns-readiness.md` §2. Only inbox verification remains.

**`GO` is not available** while R-01, R-02 and R-04 are open — signup cannot
complete without a verification email, and no message has ever been received
from this domain.

**`NO-GO` would be wrong.** Every blocker is external configuration measured in
minutes, not engineering work, and none indicates an unsound product.

## Pilot scope

Caps are set by the single-operator constraint (R-11), not by technical
capacity. Support attention is the scarce resource.

| Parameter | Value | Why |
|---|---|---|
| Initial organisations | **1** | Prove onboarding end to end once before repeating it |
| Maximum during pilot | **3** | One operator, no cover |
| Users per organisation | **≤ 10** | |
| Total customer records | **≤ 500** | Comfortably inside Supabase Free |
| Duration | **4 weeks**, reviewed weekly | |
| Data sensitivity, week 1 | Low-sensitivity only | Deliberate — see below |
| Data sensitivity, week 2+ | Real records, once week 1 is clean | |

### Prohibited during the pilot

- Any organisation that cannot tolerate up to ~24h of data loss (R-09).
- Migrating an entire existing patient database in as the first action.
- Any use requiring a contractual SLA, uptime commitment, or a signed data
  processing agreement — none exists, and `/terms` says so.
- Any workflow where a missed appointment reminder causes real harm. Reminder
  delivery is the least-proven path in the system.

## Operations

| | |
|---|---|
| Onboarding owner | Repository owner |
| Support channel | Direct contact with the operator |
| Support hours | Best-effort; no 24-hour cover (R-11) |
| Escalation | `docs/support-runbook.md` §3 — single operator, containment over repair |
| Monitoring | Production monitor every ~30 min — 10 checks always, plus 10 derived from `/api/health/ops` when it answers (20 on a healthy run). Opens an assigned GitHub issue on failure. |

## Success metrics

| Metric | Target |
|---|---|
| Verification emails delivered to inbox | 100% |
| Signup → first booking, unaided | Achieved by the pilot owner without operator intervention |
| Production monitor green | ≥ 99% of runs |
| Unexpected 5xx | 0 |
| Outbox dead letters | 0 |
| S1/S2 incidents | 0 |
| Cross-tenant data access | 0 — any occurrence ends the pilot |

## Stop criteria

End the pilot and take the service offline immediately on:

- any cross-tenant data access;
- any unauthorised access to clinical records;
- data loss not recoverable from backup;
- an S1 that cannot be contained within one working day;
- outbox dead letters climbing with no diagnosis.

Pause new onboarding (existing organisations continue) on: a monitor check
failing repeatedly without diagnosis, or two S2 incidents in one week.

## Daily review

- [ ] Monitor green; no open incident issue.
- [ ] Outbox `pending` not climbing, `dead` = 0.
- [ ] No unexpected 5xx in Vercel logs.
- [ ] Backup ran within 26h.
- [ ] Ask the pilot organisation whether anything looked wrong.

## End-of-pilot review

Decide explicitly: continue, extend, or stop. Reconcile every metric above,
close or re-accept each risk, complete the legal review, and confirm whether
the caps can safely rise.

---

## Go/no-go matrix

| Gate | Evidence | Owner | Status | Severity | Action | Consequence if unresolved |
|---|---|---|---|---|---|---|
| **Production encryption key parses** | Malformed; `/api/cron/audit-digest` → 500 (R-16) | **owner** | **FAIL** | **P0 Blocker** | Prefix with `<key-id>:` | **Signup, clinical fields and MFA all 500** |
| Unit/integration suite | 1003 tests, 83 files, exit 0 | agent | **PASS** | — | — | — |
| Browser/mobile/a11y suite | 177 passed, 3 skipped, 6 projects, exit 0 | agent | **PASS** | — | — | — |
| Suite runs in CI | `e2e` job added (P15-006) | agent | **PASS** | — | — | Regressions invisible |
| TypeScript / lint / format | exit 0 | agent | **PASS** | — | — | — |
| Production build | exit 0, 40 static pages | agent | **PASS** | — | — | — |
| `npm audit --audit-level=high` | 0 vulnerabilities | agent | **PASS** | — | — | — |
| Secret scan | gitleaks full history, 0 leaks | agent | **PASS** | — | — | — |
| Migrations at head | 2026-08: 62 applied, no drift. `main` now carries **63**; a clean install applies all 63 with no drift. **Production migration status is unknown — unreachable.** | agent | **PASS (CI) / UNKNOWN (prod)** | — | Re-check after restore | Restored dump will be at 62 |
| Production health | 2026-08: 18/18 monitor checks. **2026-09-01: 6/10 — the database is gone (R-20), and the ten ops-derived checks are not evaluated at all.** | agent | **FAIL** | **P0 Blocker** | Restore the database | **Nothing DB-backed works** |
| Backup + restore drill | **2026-09-01: backup 242.9h stale and failing (R-20); restore drill `33491958258` PASS against the 2026-08-22 artifact** | agent | **MIXED** | **P1** | Restore the database; the drill already proves the chain | Recovery point expires ~2026-09-26 |
| Tenant isolation | RLS + role/grant suites green | agent | **PASS** | — | — | — |
| Erasure completeness | P15-002 fixed, complement-proven | agent | **PASS** | — | — | — |
| Sending domain verified | DKIM/SPF/bounce MX present under `send.bookpitch.ge` (R-01 retracted) | agent | **PASS** | — | — | — |
| Provider accepts and delivers | Phase 13: `delivered@resend.dev → delivered` | agent | **PASS** | — | — | — |
| Organisational DMARC | `_dmarc.bookpitch.ge` absent (R-02) | **owner** | **OPEN** | Hardening | Publish `_dmarc` at `p=none` | Reduced spoofing resistance |
| **Real message received and headers inspected** | Never done (R-04) | **owner** | **FAIL** | **Blocker** | UAT checklist §A–B | **Inbox delivery unproven** |
| Production signup by a human | Not performed (R-05) | **owner** | **OPEN** | Conditional | UAT checklist | Primary journey unproven in prod |
| Legal review | Drafts; operator identity absent | **owner + adviser** | **OPEN** | Conditional | `docs/legal-review-checklist.md` | Users trust unreviewed text |
| Treatment-history erasure | Undecided (R-13) | **owner + adviser** | **OPEN** | Conditional | Legal decision | Erasure may be incomplete |
| Dependabot alerts | Disabled (R-06) | **owner** | **OPEN** | Conditional | Enable in settings; free | No CVE alerts between pushes |
| DMARC `rua` reachable | Unreachable (R-03) | **owner** | **OPEN** | Hardening | Point at a real mailbox | No DMARC visibility |
| Branch protection | Unavailable on plan (R-07). Re-attempted 2026-09-01: `PUT /branches/main/protection` → 403 "Upgrade to GitHub Pro or make this repository public". | **owner** | **ACCEPTED** | Accepted | Upgrade to GitHub Pro, then apply the rule in the September ledger §11. Do **not** make the repository public to obtain it. | Human error possible |
| PITR / 24h RPO | Supabase Free (R-09) | **owner** | **ACCEPTED** | Accepted | Disclosed in `/terms` | Up to ~24h loss |
| Backup residency | Not EU-guaranteed (R-10) | **owner** | **ACCEPTED** | Conditional | Legal decision | Residency claim unsupportable |
| Single operator | No second responder (R-11) | **owner** | **ACCEPTED** | Accepted | Caps + runbooks | Unattended incidents |
| Weekly cron reliability | Dropped 2026-08-17; now hourly + idempotent (R-08) | agent | **PASS** | — | — | — |
| Digest durability | Enqueued to the outbox; metric moves (R-15) | agent | **PASS** | — | — | — |

### The shortest path to `GO`

0. **Correct `FIELD_ENCRYPTION_KEY`** to `<key-id>:<64-hex-chars>` and confirm
   `POST /api/cron/audit-digest` returns 200. Nothing else matters until this
   is done — signup fails before any mail is queued.
1. **Designate a test mailbox** and run `docs/production-uat-checklist.md`
   §A–B, confirming `spf=pass`, `dkim=pass`, `dmarc=pass` from the real
   headers.

That clears both blockers. `_dmarc.bookpitch.ge` and the unreachable `rua` are
hardening, not blocking. The remaining `OPEN` items are conditional, provided
the pilot organisation is told in writing that the legal documents are drafts.
