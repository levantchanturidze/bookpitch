# Phase 7 — RBAC Security Review

**Reviewer:** Claude (Phase 7 adversarial pass, read-and-probe only)
**Date:** 2026-07-29
**Branch:** `rbac-rebuild` at `ecd5b2a` (post-Phase-6)
**Scope:** every attack surface listed in `docs/rbac-promts.md` Phase 7 —
cross-tenant isolation, privilege escalation, impersonation, break-glass,
audit-log integrity. Ran against the multi-tenant fixtures from Phase 3 +
Phase 5 (`prisma/rbac-fixtures.ts`).

**Deliverable format** per prompt: findings first, then fixes and
regression tests. Each finding maps to a probe in
`tests/security-review.test.ts`.

## Status

- **2026-07-29 pass** — all three original findings (SEC-001, SEC-002,
  SEC-003) shipped fixes. Regression probes are plain `it(...)` and pass.
- **2026-08-03 delta pass** — 14 new probes covering the platform §6.1
  routes that landed after 2026-07-29 (F-08 edit-org, feature toggles,
  org create, platform-role assignment). Two findings surfaced and were
  fixed the same day: **SEC-004 (High)** — org-toggles mutation writes
  no audit row; **SEC-005 (Medium)** — `platform.config.manage` missing
  from `RESTRICTED_DURING_IMPERSONATION`. Regression probes P6.13 + P6.14
  are now plain `it(...)` and pass. See
  [§6 Delta findings](#delta-findings) below.
- **2026-08-05 inventory-driven pass** — the full-surface inventory
  (`docs/features-en.md`) surfaced **SEC-008 (High)** — three org toggles
  writable + audit-logged but read by no code — and a companion sweep of
  20 seeded permissions with no requirePermission/can() callsite.
  Toggles wired into `can()` (regression probes P8.1–P8.3);
  orphaned permissions each tagged `notYetImplemented: '<bundle>'` in
  `prisma/rbac-seed.ts`; CI check
  (`scripts/check-orphan-perms.ts`, `npm run check:orphan-perms`) fails
  the build when a new seeded permission lands without either a
  callsite or a bundle tag. See [SEC-008](#sec-008) below.
- **2026-08-06 follow-up pass** — post-SEC-008 review surfaced
  **SEC-009 (High)** — `changeOrganizationOwner` updated
  `organizations.owner_user_id` but left the target's `memberships.role`
  and `memberships.role_id` unchanged. After the call the audit log
  recorded a successful ownership transfer; `can()` still evaluated the
  target against their old role, so the new owner could not exercise any
  owner-only permission. Fixed atomically in the same transaction.
  Regression probe P9.1. Additionally: P8.4 added to guard
  `assertDiscountWithinCeiling` enforcement (the only discount-ceiling
  gate had no test; removing it would not have broken CI).
  See [SEC-009](#sec-009) below.

## Executive summary

| ID | Severity | Surface | Title | Status |
|---|---|---|---|---|
| [SEC-001](#sec-001) | Medium | Cross-tenant | Customer routes return 200 + body-shape for cross-tenant IDs instead of 404 | **Fixed** 2026-07-29 |
| [SEC-002](#sec-002) | Low-Medium | Cross-tenant | `/api/customers/[id]/export` throws an unmapped 5xx for missing / cross-tenant IDs | **Fixed** 2026-07-29 |
| [SEC-003](#sec-003) | High | Break-glass | Break-glass read-audit failure is silently swallowed (spec §7.2 rule 6 violation) | **Fixed** 2026-07-29 |
| [SEC-004](#sec-004) | High | Audit integrity | `updateOrgToggles` writes no audit row — clinical/PII toggle flips leave no evidence | **Fixed** 2026-08-03 |
| [SEC-005](#sec-005) | Medium | Impersonation | `platform.config.manage` missing from `RESTRICTED_DURING_IMPERSONATION` — impersonating actor can flip clinical-visibility toggles | **Fixed** 2026-08-03 |
| [SEC-006](#sec-006) | High | Availability | `assignPlatformRole` can demote the last SUPER_ADMIN and brick `platform.role.assign` | **Fixed** 2026-08-03 |
| [SEC-007](#sec-007) | High | RLS bypass | Superuser Prisma client `prismaAdmin` exported publicly — 6 ordinary request paths bypass RLS. Bookpitch_app NOBYPASSRLS is the spec's 2nd layer of tenant isolation and it was inactive at these callsites | **Fixed** 2026-08-03; end-state `bookpitch_login` migration shipped 2026-08-04 (operator activation pending) |
| [SEC-008](#sec-008) | High | Silent non-enforcement | Three org toggles (`providerFinancialReports`, `providerClinicalNotesOthers`, `frontdeskClientFullHistory`) editable + audit-logged + read by nothing. Toggle appears to grant elevated visibility; no code path enforces the grant. Same class as the 20 seeded permissions with no callsite (orphan-perm sweep) | **Fixed** 2026-08-05 |
| [SEC-009](#sec-009) | High | Ownership transfer | `changeOrganizationOwner` updated the org pointer but not the target's membership role. Audit log recorded success; new owner's `can()` still evaluated against old role. Owner-only actions (billing, ownership transfer) denied to the new owner until next full role sync | **Fixed** 2026-08-06 |

## Round 4 findings (2026-08-06 adversarial pass)

| ID | Severity | Surface | Title | Status |
|---|---|---|---|---|
| F1 | High | Distributed state | `requireFreshPassword` used an in-memory Map for reauth grants — grants invisible across Vercel instances; a different cold instance always denied the destructive action | **Fixed** 2026-08-06 |
| F2 | High | Break-glass MFA | Break-glass re-auth required only password (no TOTP) despite spec §7.2 rule 3 | **Fixed** 2026-08-06 |
| F3 | Medium | Onboard abuse | `/api/onboard` had no rate limiting, no body-size guard, no CAPTCHA gate, and exposed discriminating error messages (email enumeration) | **Fixed** 2026-08-06 |
| F4 | Medium | PII in logs | Raw `err.message` from pg/Stripe/SMS providers logged without sanitisation — DETAIL clauses expose email values that triggered unique-constraint violations | **Fixed** 2026-08-06 |
| F5 | Low | Superuser URL | `DATABASE_URL_SUPERUSER` fallback chain ended at `APP_URL`, a public HTTP address. In the env-var-misconfiguration case `unsafePrismaAdmin` would have tried to open the Next.js frontend as a Postgres endpoint | **Fixed** 2026-08-06 |
| F6 | Medium | CI gap | No CI workflow existed — lint, tsc, test, guard checks, orphan-perm check ran only on developer machines | **Fixed** 2026-08-06 |
| F7 | Info | Permission drift | `payment.discount:limited` and `payment.discount:unlimited` seeded but no route enforces them (no discount UX exists yet). Tagged `notYetImplemented: 'payment_discount'` per SEC-008 process | **Documented** 2026-08-06 |

Seven findings. **No new critical findings.** The platform plane now satisfies spec §7.2 rule 3 (password + TOTP for break-glass). Distributed reauth state and log-PII are both closed.

### F1 — Distributed reauth state

**Root cause:** `requireFreshPassword` / `verifyPasswordFresh` stored grants in a module-level `Map`. Every Vercel cold-start got an empty map; the route handler that performed the reauth and the route handler that consumed the grant were frequently on different instances.

**Fix:** Replaced the in-memory map with a `platform_reauth_grant` table (primary key = `user_id`, expiry column). An L1 in-process cache is kept as an optimisation for the same-instance fast path but is never the _only_ check. The `platform_rate_limit` table (already added for SEC-007) provides the attempt counter.

**Migration:** `prisma/migrations/20260806000000_platform_security/migration.sql` — `platform_reauth_grant`, `platform_rate_limit`.

**Tests:** `tests/platform-password-reauth.test.ts` — all 6 tests, including freshness expiry with a negative `maxAgeMs` window.

### F2 — Break-glass MFA gap

**Root cause:** `startBreakGlass` called `verifyPasswordFresh` but had a `TODO` comment for the TOTP step. `mfaEnabled=true` was written to the seed user but never checked.

**Fix:**
- `lib/platform/mfa.ts` — new module: `generateTotpEnrollment`, `confirmTotpEnrollment`, `verifyTotp`. Secrets stored AES-256-GCM encrypted (same `FIELD_ENCRYPTION_KEY` as clinical notes). Replay protection via `mfa_last_totp_window` (BigInt, updated atomically on each successful verify).
- `lib/platform/break-glass.ts` — added `await verifyTotp(input.actor.userId, input.totpCode)` after password step.
- `app/api/platform/break-glass/route.ts` — `totpCode` now a required body field.
- `app/api/platform/mfa/enroll/route.ts`, `confirm/route.ts` — new enrollment API endpoints.

**Migration:** `mfa_totp TEXT`, `mfa_last_totp_window BIGINT` columns on `app_users`.

**Tests:** `tests/platform-mfa.test.ts` — enrollment (SUPER_ADMIN can enroll, others 403), confirmation (correct code enables MFA, wrong code rejected), `verifyTotp` (valid, reuse, invalid, not-enrolled), break-glass without MFA → 400. `tests/platform-break-glass.test.ts` — all break-glass tests updated to include `totpCode`.

### F3 — Onboard endpoint abuse protection

**Root cause:** `/api/onboard` was a public endpoint with no rate limiting, no body-size cap, and no CAPTCHA. `InvalidInputError` messages including `'email already registered'` were forwarded to the response, enabling email enumeration.

**Fix:**
- 16 KB body-size guard (reads `content-length` before JSON parsing).
- IP-keyed rate limit: 5 signups per IP per hour via `consumeGlobalBucket`.
- Optional Cloudflare Turnstile CAPTCHA (active when `TURNSTILE_SECRET_KEY` is set; skipped in dev/test).
- All `InvalidInputError` responses now return the generic `{ error: 'invalid request' }` body.

**Tests:** `tests/onboard-security.test.ts` — oversized payload, duplicate-email (generic 400), invalid email (generic 400), rate limit exhaustion, cross-IP isolation, CAPTCHA skip in dev mode, valid-payload 201.

**Bonus fix:** `onboardOrg` (the service function) did not set `owner_user_id` on the created org, violating invariant 5. Fixed in `lib/onboarding.ts` — `owner_user_id` is now set atomically inside the creation transaction.

### F4 — PII in error log messages

**Root cause:** Ten call sites passed `(err as Error).message` directly to `log.error`. Third-party drivers (pg, Postmark, SMS Office, Stripe) embed the triggering value in failure messages (`DETAIL: Key (email)=(…) already exists.`). `scrubPhi` only strips known structured key names; it does not scan string values.

**Fix:** `sanitizeErrorMessage(err)` in `lib/logger.ts` strips PostgreSQL DETAIL clauses, E.164 phone numbers, email addresses, and connection strings from the raw `err.message`. Every affected `log.error` / `log.warn` call site updated to use it.

**Tests:** `tests/logger.test.ts` — six `sanitizeErrorMessage` tests covering each pattern (DETAIL clause, phone, email, connection string, non-Error value, benign passthrough).

### F5 — Superuser URL fallback to APP_URL

**Root cause:** `SUPERUSER_URL` in `lib/db.ts` fell back to `process.env.APP_URL` if all four superuser DB env vars were absent. `APP_URL` is the public Next.js hostname. Connecting to it as a Postgres endpoint would time out, but the env-var misconfiguration case now silently produces a broken admin client instead of failing loudly at startup.

**Fix:** Removed `APP_URL` from the fallback chain. `SUPERUSER_URL` is now `undefined` when no superuser env var is set, which causes Prisma to throw at the first use rather than swallowing the misconfiguration.

### F6 — No CI workflow

**Fix:** `.github/workflows/ci.yml` — runs on `push`/`pull_request` targeting `main`. Steps: format check, lint, `tsc --noEmit`, `prisma validate`, `prisma migrate diff` (no pending migrations), `prisma generate`, `npm test` (all 418 tests), `check-guards`, `check-orphan-perms`, `next build`.

### F7 — Permission drift (documented, not a runtime bug)

`payment.discount:limited` and `payment.discount:unlimited` are seeded in `prisma/rbac-seed.ts` but no route enforces them — there is no discount UX yet. Tagged `notYetImplemented: 'payment_discount'` per the SEC-008 process. CI `check-orphan-perms` will catch any addition without a corresponding enforcement callsite.

Three real findings across 37 probes. **No critical findings.** The
Phase 1 append-only invariant holds, RLS holds, cross-tenant data is
not leaked in the body, privilege escalation paths are all closed. The
issues we found are HTTP-contract problems + one silent-audit-failure
that undermines the break-glass promise if the DB layer misbehaves.

## Fingerprint of the system reviewed

- 92 server-side entry points; 77 guarded, 15 explicitly exempt with
  alternate auth (webhooks, cron, health, onboard, public book,
  invite-accept, auth reset).
- 4 org fixtures + 4 platform-role users. Multi-tenant coverage
  (one user in multiple orgs, one solo-doc with two hats,
  BRANCH_MANAGER scoped to 2 of 3 branches) — the review is against a
  populated fixture, not an empty DB.
- RLS on 17 tenant tables (Phase 1 + Phase 6 `ownership_transfers`).
- Append-only enforcement: BEFORE UPDATE / BEFORE DELETE / BEFORE
  TRUNCATE triggers + revoked grants on parent + every partition +
  partition-creation helper that revokes on rollover.
- 15 in `RESTRICTED_DURING_IMPERSONATION` (Phase 6 populated).

---

<a name="sec-001"></a>
## SEC-001 — Cross-tenant customer routes: 200 body-shape instead of 404 · Medium

**Attack surface**: cross-tenant isolation
**Reproduction**: `tests/security-review.test.ts` §cross-tenant
`P1.1`, `P1.2`, `P1.3` (all `it.fails`).

### Behaviour

Hitting `GET|PATCH|DELETE /api/customers/[id]` where `[id]` belongs to
another organization returns **HTTP 200** with a body shape that
serializes an inner `NextResponse` object. The customer's data itself
is **not** in the response — RLS filters the row before it ever
reaches the handler, so `tx.customer.findUnique(...)` returns `null`
and the handler's branch runs. The bug is that the handler branch does
`return NextResponse.json({error: 'Not found'}, {status: 404})` from
inside `withApi`, which then wraps the returned NextResponse in
**another** `NextResponse.json(...)` at status 200.

### Impact

- No data leak (RLS enforces).
- HTTP contract broken — clients cannot rely on status codes to
  distinguish "not found" from "success".
- Weak enumeration: an attacker can distinguish
  "your-org's-id" (returns real DTO) from "not-your-org / nonexistent
  id" (returns null-shape 200). They cannot distinguish those last two
  from each other.

### Affected files

- `app/api/customers/[id]/route.ts` — three sites: line 29-31 (GET),
  line 52-54 (PATCH), line 80-82 (DELETE).
- Any other route inside `withApi` that returns a bare `NextResponse`
  for the not-found case. `scripts/check-guards.ts` doesn't detect
  this class of bug. A quick grep is
  `rg 'NextResponse.json.*status: 404' app/api` — investigate each
  hit.

### Suggested fix

Use the `NotFoundError` class added in Phase 5 (`lib/auth.ts`
line 109-114):

```ts
// Before:
if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 });

// After:
if (!customer) throw new NotFoundError('customer not found');
```

`withApi`'s `mapError` already turns `NotFoundError` into a proper 404.
One-line change per site.

### Regression test

Live in `tests/security-review.test.ts` (`P1.1`, `P1.2`, `P1.3`),
now plain `it(...)` and passing.

### Resolution — 2026-07-29

All three sites in `app/api/customers/[id]/route.ts` swapped from
`return NextResponse.json({error:'Not found'}, {status:404})` to
`throw new NotFoundError('customer not found')`. The same anti-pattern
was found at:

- `app/api/customers/[id]/history/route.ts:40` — same fix
  (`throw new NotFoundError`).
- `app/api/appointments/[id]/route.ts:94` — same fix.
- `app/api/customers/[id]/route.ts:90-94` — same class of bug for the
  409 branch; converted to `throw new ConflictError(...)`.

`NextResponse` import removed from all three files. `withApi`'s
`mapError` produces the correct HTTP status for each throw class.

---

<a name="sec-002"></a>
## SEC-002 — Customer export throws unhandled InvalidInputError · Low-Medium

**Attack surface**: cross-tenant isolation (secondary: error hygiene)
**Reproduction**: `tests/security-review.test.ts` §cross-tenant `P1.5`
(`it.fails`).

### Behaviour

`POST /api/customers/[id]/export` is not wrapped in `withApi`. When
`exportCustomerData(session, id)` in `lib/gdpr.ts:81` throws
`InvalidInputError('customer not found')` — which happens when the
`[id]` belongs to another org (RLS filters the row) or simply doesn't
exist — the throw escapes to the Next.js runtime unhandled. Response
is a generic 500 with (in dev) a stack trace.

### Impact

- No data leak.
- 500 instead of 4xx.
- In dev, potential stack-trace disclosure (Next.js includes source
  frames in the error page).
- Complicates client-side error handling — the export flow can't tell
  the difference between "customer doesn't exist" and "server on fire".

### Affected files

- `app/api/customers/[id]/export/route.ts` (whole file — 22 lines).
- Related to SEC-001: `lib/gdpr.ts:81` uses `InvalidInputError` for
  what's really a not-found; consider using `NotFoundError` there too.

### Suggested fix

Wrap the export route in `withApi`. Two lines:

```ts
export async function POST(req: NextRequest, { params }: ...) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.export', {...}, 'customers');
    const { id } = await params;
    const data = await exportCustomerData(ctxToSession(ctx), id);
    // withApi expects a JSON-serializable value, not a NextResponse.
    // For an attachment we need a custom return path — keep the current
    // NextResponse construction OUTSIDE withApi, but catch the throw:
    return { data, filename: `customer-${id}-export.json` };
  });
}
```

Downside: `withApi` always returns `NextResponse.json(...)`, so the
attachment `content-disposition` header would need to be set differently.
Cleaner shape:

```ts
export async function POST(...) {
  try {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.export', {...}, 'customers');
    const { id } = await params;
    const data = await exportCustomerData(ctxToSession(ctx), id);
    return new NextResponse(...);  // existing attachment shape
  } catch (err) {
    if (err instanceof InvalidInputError) return NextResponse.json({error: err.message}, {status: 400});
    if (err instanceof NotFoundError) return NextResponse.json({error: err.message}, {status: 404});
    if (err instanceof ForbiddenError) return NextResponse.json({error: err.message}, {status: 403});
    if (err instanceof UnauthenticatedError) return NextResponse.json({error: err.message}, {status: 401});
    throw err;
  }
}
```

Alternatively, extract a `withApiRaw()` helper that runs the guard +
error-mapping but lets the handler return any Response.

Same investigation prompt as SEC-001: `rg 'export async function' app/api | xargs grep -L withApi`
finds routes not using the wrapper.

### Regression test

`P1.5`, now plain `it(...)` — asserts the response status is 4xx.

### Resolution — 2026-07-29

Introduced `withApiRaw()` in `lib/auth.ts` — same guard + `mapError`
error-mapping as `withApi`, but the handler returns a bespoke
`Response` (attachment / CSV / stream) instead of a JSON body.

- `app/api/customers/[id]/export/route.ts` now wraps in `withApiRaw` so
  `InvalidInputError('customer not found')` from `lib/gdpr.ts:81`
  surfaces as a mapped 400 JSON response instead of a raw 500 / stack
  trace. (Follow-up: `lib/gdpr.ts:81` still uses `InvalidInputError`
  for a semantically-not-found; leaving as-is — the response is safe
  and swapping to `NotFoundError` there is a semantic tidy-up, not a
  security fix.)
- `app/api/insurance/export/route.ts` — same class of bug (only mapped
  `InvalidInputError`, everything else escaped). Migrated to
  `withApiRaw` in the same commit for consistency.

---

<a name="sec-003"></a>
## SEC-003 — Break-glass read audit-write failure silently swallowed · High

**Attack surface**: break-glass integrity (spec §7.2 rule 6)
**Reproduction**: `tests/security-review.test.ts`
§impersonation-and-break-glass `P3.8` (`it.fails`).

### Behaviour

`lib/platform/api.ts::withPlatformApi` wraps the break-glass audit
write in a `.catch()` with no logging or fail-closed behaviour:

```ts
if (ctx.isBreakGlass) {
  await auditBreakGlassRead(ctx, action).catch(() => {
    // Never let an audit-write failure change the response...
    // Prefer a lost audit row over a false 500...
  });
}
```

If the DB refuses the audit INSERT (permission denied, disk full,
constraint violation, transient error), the request still succeeds
with 200 — **and no audit row is written**. Spec §7.2 rule 6 says
"reads are audited". A silent-drop violates that literally.

### Impact

- Broken evidentiary contract. The audit log is the single source of
  truth for "did Bookpitch staff read this clinical record?" If it
  can be silently bypassed, its value in legal discovery is
  degraded — one lost row is enough for an adversary to argue
  the whole record is unreliable.
- Detection gap. The `.catch(() => {})` doesn't log anywhere; if
  audits stop landing due to a bug, nobody notices until the next
  compliance review.
- Attack scenario is narrow (requires DB-level control) but the
  MITIGATION is trivial to add.

### Affected files

- `lib/platform/api.ts:36-40`.
- Every route under `app/api/platform/**` inherits this behaviour
  via `withPlatformApi`.

### Suggested fix

Two-layer:

1. **Log loud on failure** — replace the swallowing catch with a
   `log.error('rbac.break_glass_audit_failed', {sessionId, action, err})`
   call. This lets Sentry (or whatever's downstream) alert.
2. **Fail-closed on repeated failures** — track consecutive audit-write
   failures per break-glass session. After N (say 2) failures, `throw`
   in `withPlatformApi` so subsequent reads return a 500. The tradeoff
   (short-window reads dropped) is preferable to unlogged reads at any
   scale.

Alternative stronger fix: on ANY audit failure, throw immediately —
preserve the spec letter, accept that a broken audit path means a
broken platform. Given SUPER_ADMIN's break-glass is rare + high-stakes,
this is defensible.

Rough patch:

```ts
if (ctx.isBreakGlass) {
  try {
    await auditBreakGlassRead(ctx, action);
  } catch (err) {
    log.error('rbac.break_glass_audit_failed', {
      sessionId: ctx.breakGlass?.sessionId,
      action,
      err: (err as Error).message,
    });
    throw new Error('break-glass audit write failed — refusing to serve read');
  }
}
```

### Regression test

`P3.8`, now plain `it(...)`. Mocks `prismaAdmin.auditLog.create` to
reject once, then hits `/platform/orgs` as SUPER in break-glass mode.
The wrapper `withApi` re-throws unknown 5xx errors (Next.js catches
them and returns 500 in production); the probe catches the throw and
treats it as status 500, then asserts `status >= 500`.

### Resolution — 2026-07-29

`lib/platform/api.ts::withPlatformApi` replaced the swallowing
`.catch(() => {})` with an explicit try/catch that:

1. Logs `platform.break_glass.audit_write_failed` at error level with
   `{action, sessionId, actorUserId, error}` — surfaces to Sentry /
   whatever's downstream so audit-path outages become visible.
2. Throws a new `Error('break-glass audit write failed — refusing to
   serve read')`. `withApi.mapError` treats unknown errors as 500 and
   re-throws so Next.js handles the response.

Behaviour verified end-to-end: the P3.8 probe's log output shows both
the loud error log and the mapped 500. Spec §7.2 rule 6 now holds
literally — a break-glass read that cannot be audited is never
served.

---

## Cleared — probes that passed (defense-in-depth coverage)

The following adversarial vectors ran the SAFE assertion and passed
against the current code. Each is now a regression canary that will
fail if the invariant is ever broken.

### Cross-tenant isolation (7 clear)

- **P1.4** — `/api/customers` list scoped correctly (isolation org sees
  only its own "Do Not Leak" customer, no cross-tenant rows).
- **P1.6** — `/api/appointments?locationId=<out-of-scope>` returns 400
  for BRANCH_MANAGER (Phase 6 branch-scope check).
- **P1.7** — `prismaApp` raw findMany with no `withOrg()` returns zero
  rows on customers, appointments, notifications (RLS predicate NULL).
- **P1.8** — cross-tenant INSERT (`withOrg(A, ...)` writing
  `organizationId: B`) rejected by RLS WITH CHECK.
- **P1.9** — raw SQL from `prismaApp` with explicit
  `WHERE organization_id = 'other'` still returns 0 rows (RLS
  policy applied on top of WHERE).
- **P1.10** — 404-for-nonexistent-id and 404-for-cross-tenant-id are
  indistinguishable (no enumeration via response shape). Note: this
  passes because BOTH return the malformed 200 currently — SEC-001
  above supersedes; after SEC-001 fix, both become 404.

### Privilege escalation (7 clear)

- **P2.1** — BRANCH_MANAGER cannot PATCH the owner's membership row
  (403 at route guard).
- **P2.2** — ORG_ADMIN cannot promote a member to ORG_OWNER (either
  403 route-level or 400 rank-level, both safe).
- **P2.3** — last-owner protection (`assertNotLastOwner`) blocks
  demoting the sole ORG_OWNER.
- **P2.4** — `switchActiveOrg` refuses a non-member org.
- **P2.5** — `/api/session/switch` to a non-member org returns 400.
- **P2.6** — `createInvitation` refuses an above-rank target role
  (Phase 6 guardrail).
- **P2.7** — PROVIDER cannot self-promote via `/api/admin/members` (403
  at route guard).

### Impersonation + break-glass (6 clear)

- **P3.1** — impersonation session past `expires_at` filtered out of
  `ctx.impersonation`.
- **P3.2** — break-glass session past `expires_at` filtered out.
- **P3.3** — ended-but-not-expired impersonation session also filtered
  out (`endedAt IS NOT NULL` in the query).
- **P3.4** — PLATFORM_ADMIN without break-glass cannot read clinical
  or `client.read:full` on any org.
- **P3.5** — SUPER_ADMIN in break-glass targeting org X can read
  clinical there, but NOT in org Y (target-org gates the reach).
- **P3.6** — impersonating actor with ORG_OWNER hat still fails on
  every `RESTRICTED_DURING_IMPERSONATION` key (org.delete,
  client.export, clinical_note.create).
- **P3.7** — every break-glass read writes a `break_glass.read.<action>`
  audit row (except when the write fails silently — see SEC-003).

### Audit-log integrity (8 clear)

- **P4.1** — UPDATE via `prismaApp` (`bookpitch_app`) fails with
  permission denied.
- **P4.2** — UPDATE via `prismaAdmin` (superuser) fails via the BEFORE
  UPDATE trigger.
- **P4.3** — DELETE via `prismaApp` fails.
- **P4.4** — DELETE via `prismaAdmin` fails via trigger.
- **P4.5** — TRUNCATE fails via BEFORE TRUNCATE trigger.
- **P4.6** — `bookpitch_app` has zero UPDATE / DELETE grants on
  `audit_log*` (information_schema check).
- **P4.7** — every existing partition also has zero UPDATE / DELETE
  grants for `bookpitch_app` — defense-in-depth against direct
  partition targeting.
- **P4.8** — INSERT continues to work (append is the point of
  append-only). Regression canary against overzealous future
  hardening.

### Auth / session (3 clear informational)

- **P5.1** — meta-canary: `withoutRls` callsites are a known set,
  reviewed in Phase 0. Any new one must be justified in a code
  review.
- **P5.2** — placeholder: NextAuth's `authorize()` is not directly
  invokable from a Vitest environment. Real coverage lives in
  `tests/rbac.test.ts` and `tests/org-switch.test.ts` which exercise
  the equivalent shape (org-switch validates membership; credentials
  rejects an orgId the user isn't in).
- **P5.3** — session-version bump on role change (spec §9 rule 10)
  observable in `app_users.sessionVersion`.

---

## Not observed during this review

- No path to write `audit_log` UPDATE / DELETE from application code.
- No cross-tenant JOIN that would bypass RLS (RLS applies per-table).
- No JWT-payload manipulation — payload is signed, and permissions
  are re-derived from the DB per request via `buildAuthContext`.
- No path where a suspended-org caller can still perform mutations
  (spec CLAUDE.md invariant #2 holds via the org-status check in `can()`).
- No path where impersonation grants clinical access (only break-glass
  unlocks — spec §7.2).
- No stale AuthContext cache bleed across org switches — the JWT
  re-issue on switch changes the cache key.

---

## Prioritization — closed

All three findings have shipped fixes on `rbac-rebuild`. Original
order-of-work was:

- **Fix now** — SEC-003 (High): shipped.
- **Fix before next release** — SEC-001 (Medium): shipped, grep pass
  caught two additional broken-404 sites outside the initial scope.
- **Fix soon (opportunistic)** — SEC-002 (Low-Medium): shipped along
  with a same-class-of-bug fix in `/api/insurance/export`.

No findings in the "accept + document" bucket.

---

## Regression test lifecycle

Each finding's probe in `tests/security-review.test.ts` is now plain
`it(...)` and passes:

- **After fix (now)**: `it(...)` passes against the fixed code.
- **If it ever regresses**: the plain `it` fails → CI fails → the
  regression is caught before merge.

Do not remove the tests. Each one is defense against re-introduction.

---

<a name="delta-findings"></a>
# Phase 7 delta pass — 2026-08-03

## Scope of the delta

Between the original review (2026-07-29 at commit `ecd5b2a`) and today
(commit `aedbe8b`), the following platform-plane routes shipped as part
of the F-08 §6.1 work:

- `POST   /api/platform/orgs`                       (org create)
- `PATCH  /api/platform/orgs/[id]`                  (edit org)
- `GET    /api/platform/orgs/[id]/toggles`          (view feature toggles)
- `PATCH  /api/platform/orgs/[id]/toggles`          (edit feature toggles)
- `GET    /api/platform/roles`                      (list platform-role holders)
- `POST   /api/platform/roles`                      (assign / revoke platform role)

Plus supporting library additions (`lib/platform/orgs.ts::createOrganization`
& `editOrganization`, `lib/platform/roles.ts::assignPlatformRole`,
`lib/rbac/toggles.ts::updateOrgToggles`).

The delta pass ran 14 probes covering guard-perm negatives + positive
controls, input validation, impersonation restrictions, and audit-row-
per-mutation. Two new findings, twelve cleared.

## Delta executive summary

| Probe | Result | Note |
|---|---|---|
| P6.1 SUPPORT_AGENT cannot POST /platform/orgs | pass (403) | `platform.org.create` correctly SUPER+PLATFORM_ADMIN only |
| P6.2 BILLING_MANAGER cannot POST /platform/orgs | pass (403) | same guard |
| P6.3 ORG_OWNER (no platform role) cannot POST /platform/orgs | pass (4xx) | platform ctx empty → deny |
| P6.4 SUPPORT_AGENT cannot PATCH /platform/orgs/[id] | pass (403) + org name unchanged | edit uses `platform.org.suspend` (same tier) |
| P6.5 SUPPORT_AGENT CAN GET /toggles | pass (200) | positive control — `platform.analytics.read` for view |
| P6.6 PLATFORM_ADMIN cannot PATCH /toggles | pass (403) | `platform.config.manage` is SUPER-only |
| P6.7 SUPER_ADMIN PATCH /toggles without reauth | pass (403) | `requireFreshPassword` fires |
| P6.8 SUPER_ADMIN with fresh reauth CAN PATCH /toggles | pass (200) | positive control |
| P6.9 negative discount ceiling → 400 | pass (400) | input validation live |
| P6.10 non-boolean toggle value ignored → 400 no editable fields | pass (400) | strict boolean coercion |
| P6.11 POST /platform/roles from PLATFORM_ADMIN → 403 | pass (403) + target role unchanged | `platform.role.assign` is SUPER-only |
| P6.12 editOrganization writes audit row | pass | `org.edit` audit landed via `writePlatformAudit` |
| **P6.13** updateOrgToggles writes audit row | **FAIL** (`it.fails`) | **SEC-004** — no audit write |
| **P6.14** platform.config.manage in RESTRICTED_DURING_IMPERSONATION | **FAIL** (`it.fails`) | **SEC-005** — key missing from set |

---

<a name="sec-004"></a>
## SEC-004 — Org-toggles mutation writes no audit row · High

**Attack surface**: audit integrity (spec §9 rule 5)
**Reproduction**: `tests/security-review.test.ts` §platform §6.1 new-surface
probes `P6.13` (`it.fails`).

### Behaviour

`updateOrgToggles(orgId, patch)` in `lib/rbac/toggles.ts:103-127` writes
the new toggle values to `organizations.features` and clears the cache.
It does not write an `audit_log` row. The PATCH route
(`app/api/platform/orgs/[id]/toggles/route.ts`) also does not write one
— it only calls `updateOrgToggles(id, patch)` and returns. The
`withPlatformApi` wrapper adds an audit row only when the caller is in
break-glass mode (`ctx.isBreakGlass`); a plain SUPER_ADMIN toggle flip
produces zero audit entries.

The toggles governed by this endpoint are the §6.2 ⚙️ items:

- `providerFinancialReports`  — expands PROVIDER's report reach
- `providerClinicalNotesOthers` — **unlocks clinical notes of OTHER
  providers** to any PROVIDER in the org
- `frontdeskClientFullHistory` — expands FRONT_DESK's PII reach
- `frontdeskDiscountCeiling`   — raises FRONT_DESK's discount authority

Every one of these is a policy-level change on data sensitivity or
authority scope. Spec §9 rule 5 requires that every mutation writes to
`audit_log`. The current implementation violates that literally for the
one operation whose evidentiary trail matters most — "when did we open
up clinical visibility, and who did it."

### Impact

- **Compliance**: the toggle flip that unlocks clinical-note visibility
  across the org has no auditable record of who did it or when. If a
  regulator asks "who authorized cross-provider clinical access on
  2026-XX-XX," the honest answer is "we don't know."
- **Forensics**: a rogue SUPER_ADMIN could open `providerClinicalNotesOthers`,
  read notes as any provider (via impersonation, subject to SEC-005),
  flip it back, and leave zero trace of the toggle event.
- **Change management**: without an audit row, the toggle history is
  unrecoverable — no timeline of feature-flag drift for support to
  reason from during an incident.

### Affected files

- `lib/rbac/toggles.ts` — `updateOrgToggles` (lines 103-127) is the
  actual write. Fix must live here or one level up in the PATCH route
  so both callers benefit (there's only one caller today).
- `app/api/platform/orgs/[id]/toggles/route.ts` — PATCH handler,
  currently forwards to `updateOrgToggles` without adding an audit row.

### Suggested fix

Add a `writePlatformAudit` call after the successful update. The
simplest patch is in the route handler, alongside where the fresh-
password check runs:

```ts
// app/api/platform/orgs/[id]/toggles/route.ts
export async function PATCH(req, { params }) {
  return withPlatformApi('org.toggles.set', async (ctx) => {
    requirePermission(ctx, 'platform.config.manage', undefined, 'platform');
    requireFreshPassword(ctx.userId);
    const { id } = await params;
    // ... existing body parsing + patch building ...

    const previous = await loadOrgToggles(id);
    const next = await updateOrgToggles(id, patch);

    await prismaAdmin.auditLog.create({
      data: {
        organizationId: id,
        actorUserId: ctx.userId,
        action: 'org.toggles.update',
        entity: 'organization',
        entityId: id,
        reason: 'platform:org.toggles.update',
        impersonationSessionId: ctx.impersonation?.sessionId ?? null,
        breakGlassSessionId: ctx.breakGlass?.sessionId ?? null,
        meta: {
          changed: Object.keys(patch),
          previous: previous as unknown as Record<string, unknown>,
          next: next as unknown as Record<string, unknown>,
        },
      },
    });

    return { toggles: next };
  });
}
```

Alternative: move the audit write into `updateOrgToggles` itself,
threading actor context through the signature. Marginally cleaner but
changes the function's interface — the route-level fix is smaller and
already has `ctx` in scope.

### Regression test

`P6.13` — flip `frontdeskDiscountCeiling` and assert `audit_log`
gained a row with `action='org.toggles.update'`. Now plain `it(...)`
and passing.

### Resolution — 2026-08-03

`app/api/platform/orgs/[id]/toggles/route.ts::PATCH` now snapshots the
previous toggles via `loadOrgToggles(id)`, applies the mutation via
`updateOrgToggles(id, patch)`, then writes an `audit_log` row with:

- `action='org.toggles.update'`
- `entity='organization'`, `entityId=id`
- `impersonationSessionId` + `breakGlassSessionId` threaded from `ctx`
  so the audit correctly attributes any change made under an active
  session
- `meta={changed: string[], previous: OrgToggles, next: OrgToggles}` —
  full before/after in structured JSON, so support can reconstruct any
  toggle timeline without replaying application logs

Also emits `log.info('platform.org.toggles.update', {...})` for
Sentry / downstream ingestion. Fix chose the route-level write over
threading `ctx` into `updateOrgToggles(orgId, patch, actor)` — smaller
diff, and `updateOrgToggles` has one caller today.

---

<a name="sec-005"></a>
## SEC-005 — `platform.config.manage` missing from RESTRICTED_DURING_IMPERSONATION · Medium

**Attack surface**: impersonation (spec §7.1 rule 5)
**Reproduction**: `tests/security-review.test.ts` §platform §6.1 new-surface
probes `P6.14` (`it.fails`).

### Behaviour

`lib/rbac/impersonation.ts::RESTRICTED_DURING_IMPERSONATION` currently
contains 15 permissions: destructive ops (`org.delete`,
`staff.deactivate`, `client.merge`, `platform.org.delete`,
`platform.org.suspend`, `platform.org.owner.change`), bulk exports
(`client.export`, `report.export`), billing changes
(`org.billing.manage`, `org.ownership.transfer`,
`platform.billing.manage`), and clinical (`clinical_note.*`).

`platform.config.manage` is NOT in the set. An actor with an active
impersonation session can still hit
`PATCH /api/platform/orgs/[id]/toggles` and flip
`providerClinicalNotesOthers`, `providerFinancialReports`,
`frontdeskClientFullHistory` for the target org.

### Impact

- **Two-step clinical exfiltration**: this is precisely the class of
  attack §7.1 rule 5 exists to block. The current restriction list
  prevents an impersonating actor from reading clinical records
  directly (`clinical_note.read:any` is restricted). But nothing stops
  them from FLIPPING `providerClinicalNotesOthers=true`, then reading
  every provider's notes AS a PROVIDER via a different session (or
  continuing the same impersonation if the target user is a PROVIDER).
- **Evidentiary gap compounds SEC-004**: because toggles produce no
  audit row today, this two-step attack would leave zero trace on the
  toggle flip and only a `break_glass.read.*` row if the reader used
  break-glass, or nothing at all if the reader used the impersonated
  user's own PROVIDER role. Fixing SEC-004 shrinks the blast radius;
  fixing SEC-005 closes the door.
- Fewer real-world users (needs impersonation) than SEC-004, but a
  higher-value attack payoff — hence Medium not Low.

### Affected files

- `lib/rbac/impersonation.ts` — line 22-48 (`DEFAULT_RESTRICTED` set).

### Suggested fix

Add `platform.config.manage` to `DEFAULT_RESTRICTED`. One line:

```ts
const DEFAULT_RESTRICTED: ReadonlySet<PermissionKey> = new Set([
  // ... existing entries ...

  // ---- Configuration changes (spec §7.1 rule 5 — "billing changes"
  //      generalized to "policy changes"). Feature toggles govern
  //      clinical visibility and PII tiers — flipping them mid-
  //      impersonation is the two-step version of a clinical read.
  perm('platform.config.manage'),
]);
```

While reviewing the set, also consider (not part of SEC-005, note for
whoever picks the fix):

- **`platform.role.assign`** during impersonation — a SUPER_ADMIN
  impersonating another user can still grant platform roles (assignment
  carries actor.userId, so audit shows SUPER_ADMIN not the impersonated
  identity — traceable). Not a real escalation vector but muddies
  incident forensics. Judgment call whether to add.
- **`platform.org.create`** during impersonation — arguably a
  legitimate diagnostic support action ("help me spin up a test org").
  Probably leave out; document the rationale in the comment.

### Regression test

`P6.14` — `expect(RESTRICTED_DURING_IMPERSONATION.has(perm('platform.config.manage'))).toBe(true)`.
Now plain `it(...)` and passing.

### Resolution — 2026-08-03

`lib/rbac/impersonation.ts::DEFAULT_RESTRICTED` gained a new
"Configuration changes" section with `platform.config.manage`. The
comment explicitly calls out why `platform.role.assign` and
`platform.org.create` are NOT added:

- `platform.role.assign` — audit already carries `actor.userId`
  (SUPER_ADMIN), so grants are traceable even when made mid-
  impersonation. Adding it would break a legitimate diagnostic
  workflow ("grant this role while I'm helping this customer").
- `platform.org.create` — a legitimate support-diagnostic action
  ("spin up a test org while I'm troubleshooting"). Not a
  clinical/PII exposure vector.

Together with SEC-004, the two-step clinical-exfiltration attack is
now closed on both ends: (a) the toggle flip is blocked mid-
impersonation, and (b) if the flip happens by a non-impersonating
SUPER_ADMIN, it's audited with full before/after state.

---

## Delta cleared — probes that passed

- **P6.1–P6.4**: guard-perm negatives on POST /orgs + PATCH /orgs/[id]
  correctly refuse SUPPORT / BILLING / ORG-plane / cross-tier callers,
  and the mutation is verifiably absent on the target row after refusal.
- **P6.5**: positive control — GET /toggles works for any platform role.
- **P6.6**: PATCH /toggles refuses PLATFORM_ADMIN (SUPER-only per
  spec §6.1 row "Feature flags / global config").
- **P6.7**: `requireFreshPassword` fires on SUPER_ADMIN without a
  recent reauth marker.
- **P6.8**: positive control — SUPER_ADMIN with fresh reauth can flip
  a toggle (used as the setup for P6.9/P6.10/P6.13 also).
- **P6.9/P6.10**: input validation correctly rejects a negative
  discount ceiling and non-boolean coercion (`1` != `true`).
- **P6.11**: `platform.role.assign` correctly refuses PLATFORM_ADMIN
  and the target's role is verifiably unchanged after the 403.
- **P6.12**: `editOrganization` correctly writes an `org.edit` audit
  row via `writePlatformAudit`. Compare with SEC-004 — the same helper
  is available for toggles and just isn't called.

---

## Delta prioritization — closed

Both delta findings shipped fixes on 2026-08-03, bundled in one commit:

- **SEC-004 (High)** — landed. Rationale for the rank + fix approach
  in the Resolution block above.
- **SEC-005 (Medium)** — landed. Rationale for the impersonation
  restriction (and the two deliberate omissions) in the Resolution
  block above.

Informational (not tracked as findings): the rationale for keeping
`platform.role.assign` and `platform.org.create` OUT of
`RESTRICTED_DURING_IMPERSONATION` is now inline in the code comment
above `DEFAULT_RESTRICTED` in `lib/rbac/impersonation.ts`.

No delta finding required a migration or a schema change.

---

## Regression suite health

- 58 total probes (37 original + 15 delta + 6 SEC-007 group-E regressions),
  all plain `it(...)`
- **58 pass, 0 `it.fails`, 0 flaky** (post-fix)
- Runs in ~1.5 s serial (fileParallelism disabled per shared DB state)

---

<a name="sec-006"></a>
## SEC-006 — `assignPlatformRole` can brick platform admin plane · High

**Attack surface**: availability / lockout (analog of spec §9 rule 1
for the platform plane)
**Reproduction**: `tests/security-review.test.ts` §platform §6.1
new-surface probes `P6.15`.

### Behaviour (pre-fix)

`lib/platform/roles.ts::assignPlatformRole` had a defensive rank check
that refused to GRANT SUPER_ADMIN from a non-SUPER caller, but no
guard against REMOVING the last SUPER_ADMIN. Two paths reached the
brick state:

1. **Self-revoke** — the only SUPER_ADMIN calls
   `assignPlatformRole(their_own_email, null)`. Their `platformRoleId`
   is nulled, `platform.role.assign` becomes unreachable, and no other
   platform user has the perm to restore it.
2. **Peer-revoke** — with two SUPER_ADMINs (A and B), A demotes B to
   PLATFORM_ADMIN, then B (now non-SUPER) also cannot restore A if A
   later revokes themselves. The first move is what SEC-006's guard
   catches; the second is a compound scenario.

Recovery from either state requires dropping into the Supabase SQL
editor and executing `UPDATE app_users SET platform_role_id = ...`
directly against the DB — not a normal operator workflow.

### Impact

- **Availability**: `platform.role.assign` is the only path to grant a
  new SUPER_ADMIN. Losing all SUPER_ADMINs makes the platform
  admin-plane read-only-ish (SUPPORT_AGENT still reads, PLATFORM_ADMIN
  still edits orgs) but destructive-tier operations (org.delete,
  role.assign, config.manage) become unreachable.
- **Blast radius**: single mistaken click in the platform-role UI.
- **Recovery cost**: superuser DB access + manual UUID lookup.

Not exploitable by an attacker (already needs SUPER_ADMIN to trigger)
— this is a lockout risk, not an escalation risk. Rated High because
"platform is bricked" is a bad Monday.

### Affected files

- `lib/platform/roles.ts::assignPlatformRole` — the mutation.

### Resolution — 2026-08-03

Added a last-SUPER_ADMIN guard mirroring
`lib/admin/last-owner.ts::assertNotLastOwner`:

```ts
if (previousRoleKey === 'SUPER_ADMIN' && roleKey !== 'SUPER_ADMIN') {
  const others = await prismaAdmin.appUser.count({
    where: {
      platformRoleId: <SUPER_ADMIN role.id>,
      id: { not: target.id },
      status: 'active',
    },
  });
  if (others === 0) {
    throw new InvalidInputError(
      'must keep at least one active SUPER_ADMIN — grant SUPER_ADMIN to another user first, then revoke this one',
    );
  }
}
```

Catches BOTH the self-revoke case (SUPER demoting themselves) and the
peer-revoke case (SUPER demoting the other SUPER when they're the last
two). Error message tells the operator the fix path — grant SUPER to
someone else first.

### Regression test

`P6.15` — asserts (a) revoke-to-null of the sole SUPER throws, (b)
demote-to-PLATFORM_ADMIN of the sole SUPER throws, (c) positive
control: with two SUPERs, demoting one succeeds. Cleans up its own
mutations so state stays consistent for the next test-file run.

---

<a name="sec-007"></a>
## SEC-007 — Unconstrained superuser Prisma client reachable from any request path · High

**Attack surface**: RLS second-layer bypass (CLAUDE.md invariant 1 —
"tenant isolation is checked first. Every query touching tenant data
filters by organization_id. A query without it is a bug regardless of
what the surrounding code appears to guarantee.")
**Reproduction**: not a runtime probe — a code-level audit + the ESLint
rule that fails builds when a new import is added without allowlisting.

### Behaviour (pre-fix)

`lib/db.ts` exported `prismaAdmin` as a public module symbol. Any file
that did `import { prismaAdmin } from '@/lib/db'` reached a `postgres`-
role connection (SUPERUSER, implicit BYPASSRLS). Six same-shape leak
vectors existed across three files:

| Callsite | Shape |
|---|---|
| `app/api/admin/staff/[id]/availability/route.ts:18` | superuser client + `where: {id, organizationId: ctx.activeOrganizationId!}` — RLS bypassed, WHERE clause is the only tenant filter |
| `lib/rbac/scope.ts::resolveBookingOwner` | same shape |
| `lib/rbac/scope.ts::resolveWaitlistOwner` (appointment lookup) | same shape |
| `lib/rbac/scope.ts::resolveWaitlistOwner` (staff lookup) | same shape |
| `lib/waitlist.ts::notifyWaitlistForCancelled` | `withoutRls` (still superuser) + `where: {organizationId: cancelledOrgId}` — same shape, escape justified by nested-tx-deadlock concern |
| `lib/rbac/scope.ts::scopedLocationIds` | **worse**: `unsafePrismaAdmin.branch.findMany({where: {id: {in: [...ctx.branchIds]}}})` with NO organizationId filter — relies entirely on ctx.branchIds having been vetted upstream |

`bookpitch_app` being NOBYPASSRLS is the second layer of tenant
isolation the spec depends on — RLS enforces the tenant filter even
when a WHERE clause is wrong. Every one of these callsites bypassed
that layer.

### Impact

- **Cross-tenant leak risk**: one bad WHERE (missing `organizationId`,
  wrong ctx field, wrong variable name in a helper) becomes an
  unbounded cross-tenant read. The layer that would have caught it
  was inactive.
- **Additive over time**: the pattern is easy to copy from existing
  code. Nothing structural prevented a new PR from adding a seventh
  callsite, or a hundredth.
- **`buildAuthContext` is the hottest path**: `lib/rbac/context.ts`
  runs on every authenticated request and holds the superuser
  connection at the base of the auth pipeline. This is legitimate
  today (see the "correct end state" section below) but it is worth
  naming explicitly — the widest privilege at the highest request
  volume in the codebase.

### Resolution — 2026-08-03

Three commits:

1. **Rename + document intent** (`c682140`).
   `prismaAdmin` → `unsafePrismaAdmin` across all 54 TS/TSX files. The
   `unsafe` prefix is a visible acknowledgement at every import line
   that the caller is reaching for a BYPASSRLS connection. Header
   comment in `lib/db.ts` documents legitimate uses (login / no-
   session, platform-plane, cron/webhook, DDL) and points at this
   finding for the full posture discussion.

2. **Availability route fix, shipped alone** (`281913e`).
   `app/api/admin/staff/[id]/availability/route.ts:18` migrated to
   `withOrg(ctx.activeOrganizationId!, tx => tx.staff.findFirst(...))`
   so RLS becomes the belt to the WHERE-clause suspenders. Shipped
   alone so the one confirmed cross-tenant risk is legible in git
   history on its own.

3. **Rename, migrations, ESLint rule** (bundled — this commit).
   - **Group E migrations**: `resolveBookingOwner`, `resolveWaitlistOwner`,
     `scopedLocationIds` in `lib/rbac/scope.ts` all migrated to
     `withOrg`. `scopedLocationIds` previously had NO organizationId
     filter at all; now RLS on `branches` is the enforcer.
   - **Waitlist refactor**: `notifyWaitlistForCancelled` now takes the
     caller's tx handle as a required first param (per your Q2 choice
     to refactor callers rather than grandfather in a `withoutRls`
     escape). Callers in `app/api/appointments/[id]/route.ts` and
     `tests/waitlist.test.ts` updated to nest the fan-out inside their
     existing `withOrg` block.
   - **Dead import cleanup**: `lib/admin.ts` was importing `withoutRls`
     but never calling it. Dropped.
   - **ESLint restrict-imports rule**: `eslint.config.mjs` now blocks
     `unsafePrismaAdmin` and `withoutRls` imports from `@/lib/db`. An
     allowlist (`UNSAFE_DB_ALLOWLIST`) covers the 33 legitimate
     importers, each tagged with its group (A/B/C/D). The rule was
     verified to fire by temporarily injecting `import { withOrg,
     unsafePrismaAdmin } from '@/lib/db'` into `app/api/customers/route.ts`
     (not on the allowlist) — `npm run lint` failed with the expected
     `no-restricted-imports` error and the SEC-007 message. Injection
     was reverted.
   - **Env-var rename** (bundled per your Q4 answer, see next
     section).

### Regression tests

**5 new probes in §7 of `tests/security-review.test.ts`:**

- **P7.1** — `resolveBookingOwner` returns the correct owner for a
  same-org appointment (positive control).
- **P7.2** — `resolveBookingOwner` returns null when the appointment
  is in another org — RLS filters the row before the handler sees it.
  This is the migration validating its own contract.
- **P7.3** — `scopedLocationIds` refuses to resolve a branch id from
  another org even when `ctx.branchIds` contains it. This is the
  "worse than the availability route" case; RLS on `branches` now
  filters the fake id.
- **P7.4** — nested `withOrg`: `resolveBookingOwner` called from
  inside an outer `withOrg(...)` tx completes with the correct answer
  under session pool. **Caveat**: this validates local Postgres +
  session-pool behavior. Transaction-pool behavior under pgbouncer
  requires activating `DATABASE_URL_SUPERUSER_TXPOOL` in prod and
  observing — worst case is that inner tx starts on a different
  connection than the outer, which is what session pool does anyway,
  so the probe reflects the shape.
- **P7.5** — availability route (the one confirmed leak vector)
  resolves same-org staff and returns null for cross-org staff via
  RLS. Direct regression on the availability fix from commit
  `281913e`.

All 5 pass. Suite is now 57/57 green.

### Environment variable rename — SEC-007 companion

The DB URL family was renamed to state the DB role's privilege in the
variable name itself. Legacy names remain valid as fallbacks so
existing deployments keep working; new deployments should use the new
names.

| New | Legacy (fallback) | Role | Privilege |
|---|---|---|---|
| `DATABASE_URL_APP_NOBYPASSRLS` | `DATABASE_URL` | `bookpitch_app` | NOBYPASSRLS, NOSUPERUSER |
| `DATABASE_URL_APP_REPLICA` | `DATABASE_REPLICA_URL` | `bookpitch_app` (replica) | NOBYPASSRLS, NOSUPERUSER |
| `DATABASE_URL_SUPERUSER_TXPOOL` | `ADMIN_RUNTIME_DATABASE_URL` | `postgres` (tx-pool) | SUPERUSER (implicit BYPASSRLS) |
| `DATABASE_URL_SUPERUSER_SESSION` | `ADMIN_DATABASE_URL` | `postgres` (session-pool) | SUPERUSER (implicit BYPASSRLS) |
| `DATABASE_URL_SUPERUSER_MIGRATE` | `ADMIN_MIGRATE_DATABASE_URL` (GH secret) | `postgres` (migrations) | SUPERUSER (implicit BYPASSRLS) |
| `DATABASE_URL_SUPERUSER_DIRECT` | `DIRECT_URL` | `postgres` (unpooled) | SUPERUSER (implicit BYPASSRLS) |

Files updated: `lib/db.ts` (precedence-lookup fallbacks), `.env.example`
(full comment block naming privilege per URL),
`app/api/health/route.ts` (reports whichever name is actually in use),
`prisma/_require-local-db-guard.ts` (checks both new + legacy names),
`.github/workflows/migrate.yml` (secret name with fallback),
`scripts/rbac-backfill.ts`.

### End state — option 3 shipped 2026-08-04

#### Security model for bookpitch_login — different from bookpitch_app

**bookpitch_app** (runtime tenant queries): NOBYPASSRLS.
RLS is the enforcer. If a query forgets its `organizationId` filter,
the RLS policy `organization_id = current_org_id()` returns zero
rows. Even a superuser bug can't leak cross-tenant data through this
role.

**bookpitch_login** (auth-context construction): **BYPASSRLS.**
This is deliberate. `buildAuthContext` runs BEFORE tenant scope
exists — it's the code that resolves *which* org the caller is in.
Before that resolution runs, `current_org_id()` is unset and every
RLS policy would return zero rows. If bookpitch_login were
NOBYPASSRLS, auth would break entirely: the membership lookup
returns nothing → buildAuthContext returns null → every request 401s.

The security guarantee for this role is therefore **not RLS**. It is
**table grants**. The role can SELECT from exactly 8 auth-graph
tables and nothing else. A bug that ever routed a customer, staff,
appointment, payment, waitlist, or clinical-note read through
prismaLogin fails with `permission denied for table <name>` at
Postgres before the query executes. This is the second layer of
defense, in a different form: RLS defends bookpitch_app, GRANTs
defend bookpitch_login.

**Proven live 2026-08-04.** Ran the migration locally, set a probe
password for bookpitch_login, connected as that role via psql, and
attempted `SELECT 1 FROM <table> LIMIT 1` against every table.
Output:

```
EXPECTED-ALLOWED tables (should all say ALLOWED):
  app_users                        ALLOWED
  memberships                      ALLOWED
  organizations                    ALLOWED
  roles                            ALLOWED
  role_permissions                 ALLOWED
  membership_branches              ALLOWED
  impersonation_sessions           ALLOWED
  break_glass_sessions             ALLOWED

EXPECTED-DENIED tables (should all say DENIED):
  customers                        DENIED     ← client PII
  appointments                     DENIED
  staff                            DENIED
  staff_availability               DENIED
  services                         DENIED
  locations                        DENIED
  branches                         DENIED
  payments                         DENIED     ← financial
  message_templates                DENIED
  message_log                      DENIED
  notifications                    DENIED
  treatment_history                DENIED     ← clinical
  waitlist                         DENIED
  audit_log                        DENIED     ← forensic
  invitations                      DENIED
  ownership_transfers              DENIED
```

The 8 auth-graph tables carry no clinical or client-PII data (they
carry email addresses, role names, permission keys, session tokens,
branch IDs). If prismaLogin is ever silently rerouted to read those,
the GRANT layer refuses.

**`bookpitch_login`** role: `BYPASSRLS` (see above), `NOSUPERUSER`,
LOGIN, and `SELECT` grants on ONLY these 8 tables:

- `app_users`
- `memberships`
- `organizations`
- `roles`
- `role_permissions`
- `membership_branches`
- `impersonation_sessions`
- `break_glass_sessions`

Every other tenant table has an explicit `REVOKE ALL` in the migration
as belt-and-braces. An accidental `prismaLogin.customer.findMany()`
fails at the Postgres GRANT layer with `permission denied for table
customers` — the hot path physically cannot reach clinical, customers,
appointments, payments, audit_log, etc.

**Ships behind a bounded fallback.** Fallback rules (see `lib/db.ts`):
- `DATABASE_URL_LOGIN` unset OR blank/whitespace-only → prismaLogin
  aliases to unsafePrismaAdmin. Safe fallback; same behavior as
  pre-SEC-007. Boot log line surfaces this (`db.prismaLogin.init`,
  `narrowRoleActive: false`) so operators can grep Vercel logs and
  see the narrow role isn't active yet.
- `DATABASE_URL_LOGIN` set + nonblank → prismaLogin is built as a
  distinct client. **If the connection fails at first query (wrong
  password, missing role, network fail), the failure propagates as a
  500 — we do NOT silently fall back to unsafePrismaAdmin.** A silent
  fallback would be a privilege escalation triggered by a typo.
- Boot log always identifies which var powered the client, so any
  drift is visible in logs.

Operator setup (any time after the migration lands via GH Actions):

1. Run `ALTER USER bookpitch_login WITH PASSWORD '<generated>'` in
   the Supabase SQL editor.
2. Add `DATABASE_URL_LOGIN` in Vercel Production with the pooled URL
   for that role (same host as `DATABASE_URL_APP_NOBYPASSRLS`, but
   the username is `bookpitch_login`).
3. Redeploy. The auth path now runs on the narrow role.

Files shipped:
- `prisma/migrations/20260804000000_bookpitch_login_role/` — role
  creation + narrow SELECT grants + `REVOKE ALL` on every other
  tenant table + reversible `down.sql`
- `lib/db.ts` — new `prismaLogin` export with fallback to
  `unsafePrismaAdmin` when `DATABASE_URL_LOGIN` is unset
- `lib/rbac/context.ts` — `buildAuthContext` swapped from
  `unsafePrismaAdmin` to `prismaLogin` (6 callsites)
- `eslint.config.mjs` — `prismaLogin` added to the SEC-007
  restrict-imports rule so it can't sprawl beyond `lib/rbac/context.ts`
  and the other allowlisted files
- `.env.example` — `DATABASE_URL_LOGIN` documented with operator
  setup pointer

Impact once activated:
- Every authenticated request runs on `bookpitch_login`, not
  `postgres`. Blast radius of a `context.ts` bug shrinks from "any
  table in the DB" to "auth-graph tables only."
- `unsafePrismaAdmin` still exists for the platform-plane paths,
  crons, DDL, and webhooks — legitimately cross-tenant use cases.
- The ESLint allowlist keeps `lib/rbac/context.ts` on it for the
  same import — the entry now covers `prismaLogin` instead of
  `unsafePrismaAdmin`, but the file is still gated on review.

Follow-up work not in this ship:
- Regression probe that asserts `prismaLogin.customer.findMany()`
  fails with permission-denied — requires the role to exist in the
  local test DB (needs the migration to run locally + a test-only
  DATABASE_URL_LOGIN). Left as a follow-up; the migration file itself
  is the primary evidence of the grant surface.
- Once `DATABASE_URL_LOGIN` is live in prod for a week without
  incident, remove the `if (LOGIN_URL) ... : unsafePrismaAdmin`
  fallback so a missing env var becomes a startup failure rather than
  a silent regression to the superuser client.

### Addendum — ownership-transfer enumeration hardening (2026-08-04)

Post-SEC-007 sweep across all 78 remaining `unsafePrismaAdmin.*` read
callsites (see the sweep report in the conversation log for the full
grid). The scopedLocationIds shape — caller-supplied ID → lookup with
no tenant filter, trust chain lives downstream — is eliminated from
the general query surface. Three residual sites in
`lib/admin/ownership-transfer.ts` (accept / decline / revoke) were
structurally justified: ownership transfers are cross-tenant by
nature (the nominee may not yet be a member of the source org), so
`withOrg(session.organizationId, …)` doesn't cleanly apply.

The residual enumeration risk — an attacker who knows a transferId
UUID could distinguish "not found" (404) from "found but not for
you" (400) — was closed by moving the ownership check into the WHERE
clause itself:

```ts
// Before:
const transfer = await unsafePrismaAdmin.ownershipTransfer.findUnique({
  where: { id: transferId },
});
if (!transfer) throw new NotFoundError('transfer not found');
if (transfer.toUserId !== session.userId) {
  throw new InvalidInputError('this transfer is not addressed to you');
}

// After:
const transfer = await unsafePrismaAdmin.ownershipTransfer.findFirst({
  where: { id: transferId, toUserId: session.userId },
});
if (!transfer) throw new NotFoundError('transfer not found');
```

Non-nominees now get the same 404 as callers who guessed a nonexistent
UUID. `revokeTransfer` uses the same shape with `fromUserId:
session.userId`. Probe **P7.6** asserts identical `NotFoundError`
class for both "not for you" and "bogus UUID" cases; positive control
confirms the addressed nominee can still decline.

Sweep summary — remaining `unsafePrismaAdmin` callsites categorized:

- **Self-lookups** (`id: ctx.userId` — trusted JWT-derived): 9
- **Bearer-token / identity claim** (email, tokenHash): 6
- **Platform-plane by design** (caller is SUPER/PLATFORM, cross-tenant
  is the whole point): 5
- **System-role / lattice reads** (`organizationId: null`): 6
- **JWT-signed identity via buildAuthContext**: 2
- **Fleet-wide count** (SEC-006 last-SUPER guard): 1
- **Ownership-transfer cross-org (structural, now hardened)**: 4

No further concerning sites remain. `bookpitch_login` narrow-role
migration (option 3 above) remains the correct end state for the
`buildAuthContext` group — that's the last place the hottest path in
the codebase touches a superuser client.

## SEC-008 — Three org toggles are writable, audit-logged, and consulted by no code · High

**Attack surface:** silent non-enforcement (grant-without-check)
**Discovered:** 2026-08-05, from the `docs/features-en.md` full-surface
inventory
**Regression tests:** `tests/security-review.test.ts` §8 — P8.1, P8.2, P8.3

### Behaviour

`updateOrgToggles` (lib/rbac/toggles.ts) stores four toggle keys under
`organizations.features`; the admin UI at `/settings/organization/policy`
edits all four; SEC-004's fix writes an audit row on every flip. Three
of the four toggles were nonetheless dead code before this fix:

- `providerFinancialReports` — spec §6.2: "grant PROVIDER access to
  branch/org financial reports."
- `providerClinicalNotesOthers` — spec §6.2: "PROVIDER can read peers'
  clinical notes."
- `frontdeskClientFullHistory` — spec §6.2: "FRONT_DESK sees full
  client history + clinical notes."

Only `frontdeskDiscountCeiling` was actually enforced (at
`lib/payments/service.ts:244`).

Concretely: `can(ctx, 'client.read:full', ...)` returned the same
answer with the toggle ON or OFF, because `toggles.ts` populates
`ctx.orgToggles` but nothing downstream consumes it. Neither did the
customer DTO builder — a call from FRONT_DESK to `GET /api/customers/[id]`
returned the same body regardless of toggle state.

### Impact

An owner opening `/settings/organization/policy`, toggling
"providers see peers' clinical notes" ON, saving, and seeing an
audit row → concludes providers now have that visibility. They do
not. The grant is a lie. Same for the other two.

This is the same class as an orphan seeded permission (a permission
row exists, no code consults it) — the sweep for that class found
20 more, tracked separately (see the CI check below).

### Affected files

- `lib/rbac/can.ts:224-260` — no branch consulted `ctx.orgToggles`
  after the `granted.has(p)` check
- `lib/customers.ts` — `toCustomerDto` / `toCustomerDetailDto` had
  no visibility parameter, so every authorised caller got every
  field (allergies + clinicalNotes decrypted, treatmentHistory in
  full)
- Every DTO caller passed no visibility context — 6 sites

### Suggested fix (as applied)

1. **`toggleGrantsPermission(ctx, p)` in `lib/rbac/can.ts`** — called
   right before the final `return false` in `can()`. Maps the three
   boolean toggles to the specific permissions they grant. Same
   pattern as the `frontdeskDiscountCeiling` check at
   `lib/payments/service.ts:244`, but for scope-based grants rather
   than numeric ceilings.

   ```ts
   if (granted.has(p)) return true;
   if (toggleGrantsPermission(ctx, p)) return true;   // SEC-008
   return false;
   ```

2. **Customer DTO gates on visibility.** New `CustomerVisibility` type
   in `lib/customers.ts`; `toCustomerDto` + `toCustomerDetailDto` both
   require it; `decideFullAccess(v)` consults BOTH `client.read:full`
   (FRONT_DESK toggle branch) OR `clinical_note.read:any` (PROVIDER
   toggle branch). Contact tier gets `allergies: null`,
   `clinicalNotes: null`, `treatmentHistory: []` — the field is always
   present so the client cannot infer "these are hidden" vs "never set."

3. **All six DTO callers updated** to pass `{ ctx }`:
   `app/api/customers/route.ts` (GET list + POST create),
   `app/api/customers/[id]/route.ts` (GET detail + PATCH),
   `app/(app)/patients/page.tsx` (server component list),
   `components/patients/actions.ts` (create + update Server Actions).

### Regression tests

Three probes in `tests/security-review.test.ts` §8 — each toggles
the flag on, hits the real path, asserts the observable response
body actually differs:

- **P8.1** — `frontdeskClientFullHistory`. FRONT_DESK reads
  `/api/customers/[id]`. With toggle OFF, `clinicalNotes` is null;
  with toggle ON, `clinicalNotes` is the decrypted string. Positive
  control asserts allergies flip in the same way.
- **P8.2** — `providerClinicalNotesOthers`. PROVIDER reads a peer's
  customer over `/api/customers/[id]`. Same shape as P8.1: OFF =
  null, ON = decrypted.
- **P8.3** — `providerFinancialReports`. `can(PROVIDER,
  'report.branch', { organizationId })` returns false with toggle
  OFF and true with toggle ON.

All three probes are plain `it(...)` and pass.

### Sweep — companion CI check for the orphan-permission class

The same shape applies to seeded permissions that have no
`requirePermission` / `can()` / `perm()` callsite. Grep of
`prisma/rbac-seed.ts` against `app/`, `lib/`, `auth.ts` found 20
such orphans across 11 feature bundles:

| Bundle | Count | Example key |
|---|---|---|
| `booking_block_time` | 3 | `booking.block_time:branch` |
| `booking_cancel_distinct` | 3 | `booking.cancel:branch` (currently folded into `booking.update`) |
| `payment_discount` | 2 | `payment.discount:branch` |
| `payment_refund` | 1 | `payment.refund:org` |
| `payment_shift_close` | 1 | `payment.shift_close:branch` |
| `staff_commission` | 2 | `staff.commission.write:branch` |
| `resources_rooms` | 2 | `resources.room.manage:branch` |
| `report_own_and_payroll` | 2 | `report.own:own`, `report.payroll:org` |
| `platform_billing` | 1 | `platform.billing.read` |
| `integrations` | 1 | `org.integration.manage:org` |
| `dead_alias` | 1 | `service.price.manage:org` (superseded by `service.write:org`) |

Rather than build 20 features or delete 20 seeded rows, each is
tagged in `prisma/rbac-seed.ts` with
`notYetImplemented: '<bundle_slug>'` and the CI script
`scripts/check-orphan-perms.ts` fails the build when a seeded
permission has no callsite AND no bundle tag. Wired into
`npm test` after `test:guards`.

Verified: injecting a fake `zzz.fake.orphan` P entry makes the
check exit 1 with a targeted listing. Removing it, exit 0.

### Related cleanup — dead feature flags removed

`lib/features.ts` declared three flags (`assistant_streaming`,
`patient_booking_widget`, `insurance_codes`) that no production code
called — same "grant without check" pattern as SEC-008 in miniature.
Rather than wire them to nothing in particular, the whole file plus
its test was deleted in the same commit. `lib/rbac/toggles.ts` no
longer references it.

### Resolution — 2026-08-05

SEC-008 closed the same day it was found. Not because the review
missed it in earlier passes — the review looked at "what is
enforced" and found no gap; SEC-008 lives in the inverse question,
"what is granted but never enforced," which only became visible
when the full-surface inventory listed every setting alongside
every code path. This is now covered end-to-end:

- `can()` consults the toggles (P8.3)
- The DTO gates on `client.read:full` OR `clinical_note.read:any`
  (P8.1, P8.2)
- CI blocks any new seeded permission that ships without a callsite
  or a `notYetImplemented` bundle tag

---

<a name="sec-009"></a>
## SEC-009 — `changeOrganizationOwner` diverges pointer from membership · High

**Attack surface**: privilege escalation / silent non-enforcement
**Reproduction**: `tests/security-review.test.ts` §9 — SEC-009, probe `P9.1`

### Behaviour

`changeOrganizationOwner` in `lib/platform/orgs.ts` (platform-admin
operation) wrote the new owner's user id into `organizations.owner_user_id`
but left two columns on the target's `memberships` row unchanged:
`role` (the legacy `'owner'` string) and `role_id` (the FK into `roles`).

Because `buildAuthContext` resolves permissions through `role_id`, and
`can()` evaluates permissions against those resolved grants, the new owner
left the function with their old role's permission set. For a PROVIDER
gaining ownership, `can(ctx, 'org.billing.manage')` returned `false`; the
person could not view billing, initiate a plan change, or start a new
ownership transfer. The previous owner's membership kept its `role='owner'`
row and was the only account that could actually exercise owner-level
authority. Neither the audit log nor the UI made this discrepancy visible.

### Why the audit log is misleading here

`writeAudit(tx, session, 'update', 'organization', orgId, ...)` was
called inside the old transaction and recorded `{ ownerUserId: newOwnerId }`.
The log entry looks like a complete successful transfer. Divergence between
`owner_user_id` and the membership `role_id` is not surfaced.

### Impact

- **Effective privilege escalation kept by the previous owner.** Their
  membership retains `role='owner'` / `role_id = <ORG_OWNER>`, so their
  `can()` results are unaffected. They remain the only party with real
  billing and transfer authority.
- **New owner's authority is paper-only.** They appear as owner in the
  UI (pointer changed) but are denied every owner-only permission check
  until a full role sync.
- **No secondary signal.** The audit log records success, the platform
  admin UI shows the new owner's email, no error is surfaced.
- Reachable only by platform admins (SUPER_ADMIN / PLATFORM_ADMIN) —
  org members cannot call `changeOrganizationOwner` directly. Risk is
  bounded to platform-admin-initiated transfers producing a broken state
  silently.

### Affected file

`lib/platform/orgs.ts` — `changeOrganizationOwner`, the "already a
member" branch that previously only called:
```ts
await unsafePrismaAdmin.organization.update({
  where: { id: orgId }, data: { ownerUserId: existingUser.id }
});
```

### Fix — 2026-08-06

The operation is now a single `$transaction` that promotes the
membership and updates the pointer atomically, or fails entirely:

```ts
const membershipId = existingUser.memberships[0].id;
const orgOwnerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
  where: { key: 'ORG_OWNER', organizationId: null }, select: { id: true },
});
await unsafePrismaAdmin.$transaction([
  unsafePrismaAdmin.membership.update({
    where: { id: membershipId },
    data: { role: 'owner', roleId: orgOwnerRole.id },
  }),
  unsafePrismaAdmin.organization.update({
    where: { id: orgId },
    data: { ownerUserId: existingUser.id },
  }),
  unsafePrismaAdmin.appUser.update({
    where: { id: existingUser.id },
    data: { sessionVersion: { increment: 1 } },
  }),
]);
```

`sessionVersion` bump forces the new owner's JWT to be re-issued within
`SV_TTL_MS` (5 s), so the corrected `role_id` is picked up at the next
authenticated request without a sign-out/sign-in cycle.

### Regression test

`P9.1` in `tests/security-review.test.ts` §9 — SEC-009:

1. Calls `changeOrganizationOwner` targeting a PROVIDER (moonlighter in
   Split Practice).
2. Rebuilds the auth context via `buildAuthContext`.
3. Asserts `can(ctx, 'org.billing.manage', ...)` is `true` — proves the
   new owner can actually exercise an owner-only permission, not just that
   the pointer changed.
4. Asserts `memberAfter.roleRef?.key === 'ORG_OWNER'` — proves the
   membership row was promoted.
5. Cleans up by restoring the original role and org pointer so the fixture
   state is unchanged for other probes.

### Companion change — P8.4 (discount-ceiling enforcement)

`assertDiscountWithinCeiling` in `lib/payments/service.ts` was the only
gate for the `frontdeskDiscountCeiling` toggle. No test exercised the
deny path — removing the guard would not have broken CI. Probe P8.4
asserts that FRONT_DESK above the ceiling is rejected, at-or-below passes,
and non-FRONT_DESK callers bypass the check (correct per spec §6.2).

