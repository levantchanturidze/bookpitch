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

## Status: all three findings fixed (2026-07-29)

All three findings have landed on `rbac-rebuild`. The regression probes
are now plain `it(...)` and pass. Details in the "Resolution" block on
each finding below.

## Executive summary

| ID | Severity | Surface | Title | Status |
|---|---|---|---|---|
| [SEC-001](#sec-001) | Medium | Cross-tenant | Customer routes return 200 + body-shape for cross-tenant IDs instead of 404 | **Fixed** 2026-07-29 |
| [SEC-002](#sec-002) | Low-Medium | Cross-tenant | `/api/customers/[id]/export` throws an unmapped 5xx for missing / cross-tenant IDs | **Fixed** 2026-07-29 |
| [SEC-003](#sec-003) | High | Break-glass | Break-glass read-audit failure is silently swallowed (spec §7.2 rule 6 violation) | **Fixed** 2026-07-29 |

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
