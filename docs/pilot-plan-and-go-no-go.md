# Pilot plan and go/no-go decision

## Recommendation

# CONDITIONAL GO (2026-09-01, 14:45Z) — no engineering blocker remains

**Superseding both recommendations below.** The database outage of 2026-09-01
(R-20) is resolved: the project was restored, migration 63 applied exactly once,
every production invariant passes, and backup and restore are proven against the
restored database. **R-16 is now verified resolved**, which is what the older
recommendation was waiting for.

The monitor reports **17/21 checks passed, 2 paused by configuration**. What
remains is not engineering:

| Remaining | Kind |
|---|---|
| No Sentry DSN — every uncaught production exception is discarded (#44) | external credential |
| A real message received and inspected in a designated mailbox (R-04) | human |
| Legal review; operator identity unset; `LEGAL_DOCUMENT_STATUS` still `'draft'` | human + adviser |
| Treatment-history erasure decision (R-13) | human + adviser |
| Organisational DMARC, `rua` reachability, Dependabot (R-02, R-03, R-06) | owner, hardening |
| Branch protection unavailable on this plan (R-07) | account plan |
| `cron-failures` — four pre-restore failures aging out of a ten-run window | self-healing |

`CONDITIONAL GO` means: the software is ready and verified in production; the
pilot is gated on the human and external items above, and on the 24-hour soak,
which cannot begin until the Sentry DSN exists (September ledger §18).

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
| Migrations at head | **63 applied in production**, 0 unfinished, 0 rolled back, `Database schema is up to date!` (runs `33509215538`, `33519944573`). Applied exactly once. | agent | **PASS** | — | — | — |
| Production health | 2026-08: 18/18. 2026-09-01 morning: 6/10, database gone. **2026-09-01 14:45Z: 17/21 passed, 2 paused, 2 failed** — `cron-failures` (self-healing) and `production-observability-unconfigured` (no DSN). | agent | **PASS with two known reds** | — | Provision the Sentry DSN | Uncaught exceptions discarded |
| Backup + restore drill | **2026-09-01 14:22Z: fresh encrypted backup `33519003403`, verified by download/decrypt/checksum in its own job; restore drill `33519293872` restored it end to end and found 63 migrations.** RPO back to ~24h. | agent | **PASS** | — | — | — |
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
