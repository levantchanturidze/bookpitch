# Phase 16 — pre-pilot product reconciliation

**Branch:** `agent/phase-16-prepilot-product-refinement`
**Baseline:** `5c8fb77353869d29cc8378f7a83e6d23a75e55ef` (frozen Phase 15 `main`)
**Status:** `LOCAL VERIFICATION PASSED — GITHUB CI PENDING`

Phase 15 is in a holding pattern: GitHub Actions is suspended for an account
billing condition until approximately 2026-09-01, so no CI run and no official
24-hour soak is possible. Nothing here is merged, pushed or deployed. Production
stays exactly as Phase 15 left it.

---

## 1. Surface inventory (derived from the repository, not from docs)

Counted at the baseline tree.

| Surface | Count | Notes |
|---|---|---|
| Pages (`page.tsx`) | 39 | 9 public/auth/legal, 18 app-plane, 6 platform, plus book/dev/offline/root |
| API routes (`route.ts`) | 77 | 5 cron, 3 health, 2 webhook, 2 public |
| Components | 38 | 31 reachable, **7 unreferenced** (see F16-004) |
| Roles | 13 | DB-backed, ranks 0–1000 |
| Permissions | 67 | 41 enforced at a call site, 19 marked `notYetImplemented`, 7 role bundles |
| Migrations | 62 | unchanged by this phase |

**Roles, by rank.** `SUPER_ADMIN` 1000 · `PLATFORM_ADMIN` 900 ·
`BILLING_MANAGER` 850 · `SUPPORT_AGENT` 800 · `ORG_OWNER` 100 · `ORG_ADMIN` 80 ·
`BRANCH_MANAGER` 60 · `SENIOR_PROVIDER` 50 · `FRONT_DESK` 40 · `PROVIDER` 40 ·
`ACCOUNTANT` 30 · `MARKETING` 30 · `CLIENT` 0.

`FRONT_DESK` and `PROVIDER` share rank 40 deliberately — `canManageRoleAssignment`
requires *both* a strict rank win and an explicit `role_can_manage` lattice edge,
so peers cannot manage each other even at equal rank.

---

## 2. Reconciliation

Each row: what the surface should do, what it does, where, what proves it, and
what was missing.

### F16-001 · The mock payment gateway was reachable in production — **P1, fixed**

| | |
|---|---|
| **Surface** | Payments: gateway selection, mock hosted-payment page, payment webhook |
| **Expected** | Production uses a real gateway. The mock adapter and its approve/decline page exist only outside production. |
| **Was** | `getGateway()` resolved `PAYMENT_GATEWAY ?? 'mock'`, so an **unset** variable selected `MockGateway` — which signs its own webhooks and reports every payment as paid. The mock page's server actions had **no environment gate at all**, and `postWebhook()` fetched a **caller-supplied URL** with a valid `PAYMENT_MOCK_SECRET` signature attached. |
| **Implementation** | `lib/payments/gateway.ts`, `app/dev/mock-gateway/pay/actions.ts`, `app/dev/mock-gateway/pay/page.tsx` |
| **Proof** | `tests/phase16-payment-gateway-failclosed.test.ts` — 14 tests |
| **Missing proof before** | `getGateway()` had **no test at all**. Every existing payment test constructed an adapter directly, so the resolution path that runs in production was never exercised. |
| **Severity** | P1. Money, and an unauthenticated signed-request primitive. |
| **External dependency** | None. |

Two separable defects sharing a root:

1. **Fail-open default.** `PAYMENT_GATEWAY` is not in any `REQUIRED_*_ENV` list,
   so its absence is not counted either — the fallback was silent in both the
   code and the monitor.
2. **Ungated server actions.** Next.js server actions are addressable by id.
   `notFound()` in the page component does not unregister the action, so the
   page's gate never protected them. `postWebhook()` then POSTed to any host the
   caller named.

Fixed with three gates, each where the decision is actually made: `getGateway()`
throws in production when the variable is unset or `mock`; the actions assert
their own environment; the webhook URL is pinned to `APP_URL`'s origin and the
`/api/webhooks/payment` path — the only value `lib/payments/service.ts` ever
passes.

**Complement proven.** Reverting the source fails 10 of 14. The SSRF case fails
with `fetch failed` — unfixed, it really does attempt the request to
`169.254.169.254`. The 4 that still pass are the preserved-behaviour cases
(mock outside production, real gateway in production, unknown-name throw).

### F16-002 · Messaging providers failed open to a silent mock — **P1, fixed**

| | |
|---|---|
| **Surface** | Outbound email and SMS: verification, reminders, alerts, digest |
| **Expected** | Production sends through a real provider, or fails loudly. |
| **Was** | `getSmsProvider()` / `getEmailProvider()` resolved `<VAR> ?? 'mock'`. The mock adapters return a `providerMsgId` without contacting anyone. |
| **Implementation** | `lib/messaging/index.ts` |
| **Proof** | `tests/phase16-messaging-provider-failclosed.test.ts` — 12 tests |
| **Missing proof before** | No test covered provider resolution by environment. |
| **Severity** | P1 for a product whose top launch risk is already email deliverability. |
| **External dependency** | None to fix. Real delivery still gated on mailbox UAT. |

The consequence is worse than an outage: an unset variable would mark every
verification email and every reminder **delivered**. The outbox row reaches
`sent`, `message_log` gets an id, and the monitor stays green while nothing
leaves the building.

`EMAIL_PROVIDER` is already in `REQUIRED_EMAIL_ENV`, so its absence *is*
counted — and that never stopped the fallback. A count is a report, not a
control. This is the same lesson as CLAUDE.md's "verify behaviour, not wiring",
reached from the configuration side.

**Complement proven.** Reverting fails 8 of 12; the 4 survivors are the
development-fallback cases that must not change.

### F16-003 · Sidebar/route permission parity was unguarded — **P3, guarded**

| | |
|---|---|
| **Surface** | App-plane navigation, all 8 sidebar entries |
| **Expected** | A sidebar entry appears exactly when its destination will admit the caller. |
| **Is** | **Correct.** All 8 pairs agree — verified pair by pair. |
| **Implementation** | `components/shell/nav-items.ts`, `app/(app)/layout.tsx`, per-page `requirePermission()` |
| **Proof** | `tests/phase16-nav-permission-parity.test.ts` — 9 tests |
| **Missing proof before** | Nothing kept the two lists in step. |
| **Severity** | P3 — no defect today, silent drift tomorrow. |

| nav id | requires | page enforces |
|---|---|---|
| scheduler | `booking.read` | `booking.read` |
| patients | `client.read:contact` | `client.read:contact` |
| reminders | `booking.update` | `booking.update` |
| waitlist | `booking.read` | `booking.read` |
| billing | `payment.charge` | `payment.charge` |
| analytics | `report.branch` | `report.branch` |
| audit | `audit.read` | `audit.read` |
| settings | `org.settings.update:org` | `org.settings.update:org` |

No product change. Drift would surface as a visible link that 403s on click, or
a working page nobody can find. Injecting a one-word drift (audit nav asking for
`booking.read`) fails the guard with the mismatch named on both sides.

Structural, not behavioural: it proves the two sources name the same key.
Enforcement stays covered by `scripts/check-guards.ts` and the route-access tests.

### F16-006 · A mocked provider was invisible to the config contract — **P2, fixed**

| | |
|---|---|
| **Surface** | Production configuration diagnostics |
| **Was** | F16-001/002 made the resolvers refuse `mock` in production, but only at the call site — the first real payment or reminder. Until then the monitor reported a complete, valid configuration. |
| **Implementation** | `lib/ops-metrics.ts` (`SECURITY_ENV_VALIDATORS`, `isRealProvider`) |
| **Proof** | `tests/phase16-provider-config-contract.test.ts` — 18 tests |
| **Severity** | P2 — turns a latent misconfiguration into a visible one before it costs a payment. |

`invalidEnv()` already existed for "set but structurally unusable" (P15-010). A
provider pinned to `mock` is exactly that, as is a typo'd name the resolver would
throw on. Absence stays with `missingEnv()`, so nothing is counted twice.

`.env.example` and `docs/operations.md` now state which providers production
requires and what happens when they are absent.

### F16-007 · Role coverage was a spot check — **P3, evidence added**

| | |
|---|---|
| **Surface** | All 13 authoritative roles × all 8 app-plane surfaces |
| **Was** | `tests/route-access.test.ts` instantiates a handful of fixture users. That is a spot check; it says nothing about the nine roles it never builds. |
| **Implementation** | none — no product change |
| **Proof** | `tests/phase16-role-surface-matrix.test.ts` — 9 tests, 104 measured cells |
| **Severity** | P3 — no defect found; the gap was evidence. |

Every cell below is **measured** by running the real `can()` against an
`AuthContext` built from the authoritative `role_permissions` rows:

```
role            scheduler patients  reminders waitlist  billing   analytics audit     settings  
------------------------------------------------------------------------------------------------
SUPER_ADMIN     deny      deny      deny      deny      deny      deny      deny      deny      
PLATFORM_ADMIN  deny      deny      deny      deny      deny      deny      deny      deny      
BILLING_MANAGER deny      deny      deny      deny      deny      deny      deny      deny      
SUPPORT_AGENT   deny      deny      deny      deny      deny      deny      deny      deny      
ORG_OWNER       ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     
ORG_ADMIN       ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     
BRANCH_MANAGER  ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     deny      deny      
SENIOR_PROVIDER ALLOW     ALLOW     ALLOW     ALLOW     deny      ALLOW     deny      deny      
FRONT_DESK      ALLOW     ALLOW     ALLOW     ALLOW     ALLOW     deny      deny      deny      
PROVIDER        ALLOW     ALLOW     ALLOW     ALLOW     deny      deny      deny      deny      
ACCOUNTANT      deny      deny      deny      deny      deny      ALLOW     deny      deny      
MARKETING       deny      ALLOW     deny      deny      deny      ALLOW     deny      deny      
CLIENT          deny      deny      deny      deny      deny      deny      deny      deny
```

Invariants now asserted: `CLIENT` (zero grants) reaches nothing; platform-plane
roles reach no app surface, because they hold no membership; every ALLOW is
justified by a grant the role actually holds; an empty bundle is denied in an
otherwise valid context; and a valid `ORG_OWNER` is denied against a different
organization.

The toggle is asserted in **both** directions — `providerFinancialReports` off
denies `PROVIDER` the analytics surface, on grants it. A toggle that does not
change an observable decision would not have been proven by the grant alone.

**Product decision surfaced, not taken:** `MARKETING` holds
`client.read:contact`, so it reaches the patients surface and patient contact
details. Defensible for campaigns, but it is a marketing role reading patient
contact data in a clinical product — worth an explicit GDPR decision rather than
an inherited default.

### F16-008 · The patients screen loads the whole tenant — **P2, reported not fixed**

| | |
|---|---|
| **Surface** | `/patients`, `/scheduler`, `GET /api/customers` |
| **Expected** | A list screen fetches a bounded page. |
| **Is** | `app/(app)/patients/page.tsx:30` runs `customer.findMany({ orderBy, include: { treatmentHistory } })` with **no `take`** — every customer in the org, plus every treatment-history row for every customer, then `toCustomerDetailDto()` decrypts allergies and clinical notes per row. `app/(app)/scheduler/page.tsx:51` loads every customer for a dropdown. |
| **Severity** | P2 — grows linearly with tenant size on the two busiest clinical screens. |

`PatientList.tsx:448` renders `treatmentHistory` for the **selected** patient
only, and `/api/customers/[id]/history` already exists for the on-demand path.
So the expensive part of the query feeds a panel that shows one patient at a
time.

`GET /api/customers` has the same unbounded shape and, separately, **no caller**
anywhere in `app/`, `components/` or `lib/`.

Query-plan evidence (local, 7 customers): plain `Seq Scan` + sort, 0.05 ms. Both
relevant indexes already exist — `idx_customers_org` and `idx_history_customer`.
**No index is proposed**: at this volume there is no plan evidence to justify
one, and the working rules forbid speculative indexes.

**Not fixed here — it is a product decision.** Every real fix (paginate, bound
the history include, fetch history on selection) changes what a user sees, and a
holding period with no CI and no browser against production is the wrong place
to make that call. `audit-query.ts` already shows the intended pattern
(`take: filter.limit ?? 200`).

### F16-009 · Privileged-session expiry is read on the process clock — **P3, reported not fixed**

| | |
|---|---|
| **Surface** | `lib/rbac/context.ts` — `loadActiveImpersonation`, `loadActiveBreakGlass` |
| **Expected** | A deadline written against the database clock is evaluated against the database clock. |
| **Is** | Both loaders compare `expiresAt` to `new Date()`. |

The write side is explicit about why this matters —
`lib/platform/break-glass.ts:84` says *"expiresAt uses DB clock to prevent Node
clock-skew pre-expiry"* — and `tests/helpers/db-time.ts` states the convention:
*"Security-sensitive code (startBreakGlass, conflict checks, expiry guards) uses
`SELECT now()` … not the Node process."* The two loaders are expiry guards that
do not follow it.

Harm direction: a runtime clock behind the database keeps an already-expired
session active, so break-glass access to client PII outlives the 60-minute
ceiling in rbac-spec §7.2. Measured skew between this host and its database:
**0 ms**, so nothing is wrong today — this is defence, not an incident.

**Attempted and reverted.** See F16-010: correcting the read alone is not
possible, because the database-time helper it would depend on is itself wrong
off-UTC, and the two errors currently cancel.

### F16-010 · `SELECT now()` through Prisma is timezone-fragile — **P2, reported not fixed**

| | |
|---|---|
| **Surface** | `lib/platform/break-glass.ts:105`, `lib/platform/impersonation.ts:80`, `lib/housekeeping.ts:78`, `tests/helpers/db-time.ts:35` |
| **Expected** | `SELECT now()` yields the current instant. |
| **Is** | Postgres renders a `timestamptz` in the session `TimeZone`; Prisma's raw path parses that rendering **as UTC**. Off-UTC, the Date is wrong by exactly the zone offset — silently, with no error. |

Measured on this machine, same connection, same moment:

```
node Date.now()                  = 2026-08-22T20:31:49.462Z
prisma SELECT now()              = 2026-08-23T00:31:49.524Z   (+4h)
prisma extract(epoch from now()) = 2026-08-22T20:31:49.526Z   (+64ms)
server TimeZone                  = Asia/Tbilisi
```

Server `TimeZone`: **production Supabase = `UTC`**, local Postgres =
`Asia/Tbilisi`. So production behaviour is correct today and this is latent, not
an incident. Off-UTC it is not subtle:

- `startBreakGlass` / `startImpersonation` set `expiresAt = dbNow + TTL`, so a
  60-minute break-glass ceiling silently becomes **five hours**;
- `housekeeping` sweeps `expires < now`, so it deletes tokens, rate-limit rows
  and reauth grants that are **still live**;
- `tests/helpers/db-time.ts` inherits the same offset, which is why the suite
  never noticed — fixtures and assertions are wrong together.

**Attempted, then reverted deliberately.** A `dbNow()` helper built on
`extract(epoch from now())` fixed the clock and made the new expiry tests pass,
but broke two break-glass tests: *"TOTP replay fence is NOT advanced when the
transaction rolls back"* and *"concurrent activations: exactly one session
created"*. Reproduced twice; baseline is 25/25.

The cause is instructive and is the finding's real teeth: **the read error and a
matching write error currently cancel.** `startBreakGlass`'s in-transaction sweep
binds a JS `Date` **into** raw SQL (`expires_at <= ${dbNow}`), which is
timezone-sensitive in the opposite direction. Correct one side and the pair stops
agreeing. Any fix must change read and write together and re-verify the
break-glass concurrency tests.

Reverted rather than shipped: this is security-critical concurrency code, GitHub
CI cannot run during the holding period, and a partially-understood change there
is worse than a well-documented finding. Recommended follow-up, as its own PR
with CI green:

1. add `dbNow()` on `extract(epoch from now())`;
2. move every raw comparison to SQL-side `now()` rather than binding a Date;
3. route `break-glass`, `impersonation`, `housekeeping`, `rbac/context` and
   `tests/helpers/db-time.ts` through it in one change;
4. prove it by setting the local server `TimeZone` to something off-UTC and
   showing the break-glass TTL is still 60 minutes.

### F16-004 · Seven unreferenced prototype components — **P4, reported not removed**

| | |
|---|---|
| **Surface** | `components/` root |
| **Files** | `AnalyticsDashboard.tsx`, `CalendarView.tsx`, `CheckoutPayment.tsx`, `ModulePlaceholder.tsx`, `OfflineManager.tsx`, `PatientDatabase.tsx`, `RemindersSystem.tsx` |
| **Status** | Imported by nothing in `app/`, `components/` or `lib/`. Every component in a `components/<area>/` subdirectory *is* reachable — the split is exactly prototype vs product. |
| **Severity** | P4. Not shipped to users: unimported modules are not in the client bundle. |
| **Proposed** | Delete, or move under `docs/prototype/`. **Not done here** — the working rules forbid removing product components without proving intent, and these plausibly remain design reference. |

Worth knowing while they stay: `CheckoutPayment.tsx:471` renders
`Authorization token: STRIPE_TX_{Math.floor(100000 + Math.random() * 900000)}`
on a "Checkout Complete!" screen — a fabricated authorization token that changes
on every re-render. Harmless while unreachable; it must never become reachable.
These seven files also account for most of the 57 lint warnings.

### F16-005 · `ASSISTANT_MODEL` fallback — **reviewed, deliberately unchanged**

`lib/assistant/model.ts:51` resolves `ASSISTANT_MODEL ?? 'mock'`, the same shape
as F16-001/002. Left alone on purpose: `MockAssistant` returns a *draft* a human
reviews before anything is created. It claims no delivery and moves no money,
and a mock draft is visible as such. The working rules say not to blanket-replace
without surface-specific proof, and the proof of harm is absent here.

Revisit if the assistant ever writes without human confirmation.

---

## 3. Verified-correct surfaces (no change made)

Checked while hunting; recorded so the next pass does not re-derive them.

| Surface | Finding |
|---|---|
| Double-booking | GiST `EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&)` in the initial migration, **plus** app-level handling of `no_staff_double_booking`. DB is the authority; app is defence in depth. |
| Route guards | `scripts/check-guards.ts` scans 105 entry points, 18 allow-listed with a documented alternate mechanism each. All guarded. |
| `app/api/dev/whoami-owner` | Despite the path, correctly guarded by `requireAuthContext()` + `requirePermission('org.settings.update:org')`. |
| Recovery codes | `app_user_recovery_codes.code_hash` is SHA-256, not ciphertext — correctly outside the encryption-key blast radius. |
| Ciphertext accounting | `lib/ops-metrics.ts` counts exactly the six columns that `encryptField()` writes. Static inventory and diagnostic agree. |
| `useNotifications` | React Compiler flags "setState synchronously within an effect" at line 59. False positive: `fetchOnce` is async, so `setState` lands after the await. Not changed. |

---

## 4. Deliberately not done

- **No push, no PR, no merge, no deploy.** Required CI cannot run.
- **No migration.** Nothing here needs a schema change; the 62-migration
  baseline is untouched.
- **No production mutation of any kind.**
- **No deletion of the seven prototype components** (F16-004) — needs owner intent.
- **Hydration-risk lint warnings** in `platform/OrgList.tsx:31` and
  `platform/OrgDetail.tsx:346` (`Date.now()` during render). Real but low
  severity, and every available fix changes SSR output — which is not
  behaviour-preserving, so it does not belong in a holding period that cannot be
  verified against a browser in production. Recorded for the post-restoration pass.
- **`PAYMENT_GATEWAY` in the production config contract.** Adding it to
  `REQUIRED_*_ENV` / `SECURITY_ENV_VALIDATORS` would be the natural completion of
  F16-001, and it changes what the production monitor reports. That change should
  land when the monitor can confirm its own effect. Proposed, not written.
