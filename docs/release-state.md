# Release state — the one current-state document

**Snapshot: 2026-09-02.** This file is the single place that says what is true
*now*. Every phase ledger is a historical record of what was true when it was
written; where a ledger and this file disagree about the present, this file
wins and the ledger is wrong only in tense, not in fact.

Status that changes on its own — monitor results, soak progress, incident
state — is **not** restated here, because a number copied into a document is
stale the moment it is written. Those live in:

- **Production monitor** — [`Production monitor` workflow runs](https://github.com/levantchanturidze/bookpitch/actions/workflows/production-monitor.yml)
- **Soak** — the open `soak`-labelled issue, updated every 30 minutes by
  `.github/workflows/soak.yml`
- **Open incidents** — [`ops-incident` label](https://github.com/levantchanturidze/bookpitch/issues?q=is%3Aissue+label%3Aops-incident)

---

## The seven states a change can be in

The single biggest source of contradiction across the ledgers is that
"done" was used for all of these. They are not the same claim.

| State | Means |
|---|---|
| **implemented** | the code exists in a working tree |
| **committed** | it is in git history somewhere |
| **pushed** | a remote has it |
| **merged** | it is an ancestor of `origin/main` |
| **deployed** | that exact SHA is serving `bookpitch.ge` |
| **production-verified** | a check ran *against production* and passed |
| **soak-verified** | it survived an uninterrupted 24h window under §13 |
| **human-approved** | a person with the authority signed it off |

Nothing is soak-verified. Nothing has been human-approved.

---

## Phases 15, 16, 17 — where each actually stands

| Phase | implemented | merged | deployed | production-verified | soak-verified | human-approved |
|---|---|---|---|---|---|---|
| **15** launch readiness | ✅ | ✅ | ✅ | ✅ except the items below | ❌ | ❌ |
| **16** reconciliation | ✅ | ✅ `e69795b` (PR #36) | ✅ | ✅ incl. F16-012 | ❌ | ❌ |
| **17** stabilization | ✅ | ✅ `86e09a9` (PR #35) | ✅ | ✅ except Sentry (P17-007) | ❌ | ❌ |

---

## Corrections — claims that were true when written and are false now

These are listed rather than deleted. The incidents happened; pretending
otherwise would destroy the record of how they were found.

| Claim, still present in some ledgers | Was true | Current truth |
|---|---|---|
| "Production has no database" | 2026-09-01, ~00:00–12:40Z | **False.** Supabase `cglqphbebckvpeyisqqb` restored 2026-09-01. Identity proven by the backup manifest fingerprint `5c9f75110f30141f`, matching pre-loss and post-restore |
| "Actions billing is suspended" | until 2026-08-31T20:55Z | **False.** Restored; real step counts from 2026-09-01T00:05Z |
| "62 migrations" | until 2026-09-01T12:43Z | **False.** 63 applied in production (run `33509215538`); `main` will carry **65** once PR #46 merges |
| "Migration 63 is local only" | until 2026-09-01T12:43Z | **False.** Applied to production exactly once |
| "MARKETING still holds `client.read:contact`" | until migration 63 applied | **False.** Verified absent in production; the two reporting grants remain, which is the complement that stops the check being vacuous |
| "`FIELD_ENCRYPTION_KEY` is malformed" | P15-010 / R-16, until 2026-08-22 | **False.** `production-config-invalid — malformed: 0`, corroborated by an encrypted `email_outbox` row that could not exist unless `encryptField()` succeeded |
| "Nothing is merged" | Phase 16 freeze window | **False.** Phases 16 and 17 merged 2026-09-01 |
| "Production monitor 18/18" / "17/21" / "18/21" | each true on its date | **Stale by construction.** See the workflow link above. PR #46 moves the gate count to **23** plus one informational line |

---

## The soak criterion

Earlier ledgers stated the target as "21/21 with 2 paused", which cannot be
satisfied: if 2 of 21 are paused then at most 19 can pass. The count also moves
whenever a check is added — PR #46 adds two — so any fixed number is wrong the
next time the monitor changes.

The criterion does not mention a total at all:

> **Every applicable check passed, only explicitly accepted checks paused, and
> zero checks failed** — held without interruption for 24 hours, on one
> deployment, with at least six *natural* monitor observations.

Encoded in `scripts/soak-controller.mjs` and asserted in
`tests/soak-controller.test.ts`. Time alone can never satisfy it: a
release-critical failure resets the window to the moment of failure, and only
`event === 'schedule'` runs count as evidence.

### Accepted paused checks

| Check | Why paused | Recorded in |
|---|---|---|
| `audit-digest-stalled` | `AUDIT_DIGEST_ENABLED` is not `true` — a deliberate pre-launch gate | `docs/audit-digest-delivery-gate.md` |
| `production-provider-mocked` | `SMS_PROVIDER` and `PAYMENT_GATEWAY` on `mock`, both accepted deferrals | `docs/deferred-features.md` § Outbound providers |

`EMAIL_PROVIDER` is **not** deferrable. A mocked email provider means nobody
can complete signup, and it is now reported as a fault rather than a pause.

---

## What is blocked, and on whom

Only these. Everything automatable is done.

### 1. Sentry — no workspace exists

`production-observability-unconfigured` fails; issue **#44** is open. Every
uncaught exception in production is discarded.

`sentry.io` serves its marketing page, which means **no authenticated Sentry
session exists**. Creating an account requires accepting Sentry's terms on the
operator's behalf, which is out of scope. This is not a configuration step
someone forgot — there is nothing to configure against.

**Needs a person to:** create or nominate a Sentry organisation and project,
then set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` in Vercel Production.
Afterwards `npm run verify:sentry` proves it end to end — it distinguishes
CONFIGURED / INITIALISED / EMITTED / **RECEIVED**, and only level 4 is
evidence that an error would reach a human. Levels 1–3 all pass against a DSN
pointing at a project that does not exist.

### 2. Legal review — `LEGAL_DOCUMENT_STATUS` is `'draft'`

`OPERATOR_IDENTITY` is all-null: no legal name, registration number, postal
address or contact. The pages render a clearly-marked gap rather than a
plausible-looking placeholder, which is honest but is not a privacy notice.

**Needs a person to:** complete `docs/legal-review-checklist.md` and flip the
constant. This can never be inferred from technical completeness, and no amount
of green CI is evidence for it.

### 3. Designated test mailbox — none nominated

No mailbox has been named, so signup and email-receipt UAT **has not been
performed** and is not claimed anywhere. Inspecting an inbox is the only thing
that proves delivery; a 200 from the provider is not.

### 4. Branch protection — accepted risk, not a gap

Unavailable for private repositories on the current plan. Recorded as **R-07**
in `docs/phase-15-risk-register.md` with explicit owner acceptance for launch
and pilot, mitigated by verifying each required check against the exact head
SHA before merging. This is a documented accepted risk, not an outstanding
item.

---

## Release verdict

**NOT FINAL SUCCESS — BLOCKED** on items 1–3 above, all of which require a
person. No engineering work is outstanding.

The soak has not started and **must not** be started while `#44` is open: an
unobserved window proves nothing, which is why the controller has an
`observability` gate that refuses to pass without verified Sentry receipt.
