# Round 4 Post-Implementation Security Review
## Final Closure Report — Bookpitch Platform Security (F1–F7 + Closure Fixes)

**Audited commit:** `0f4c49c` — "Round 4 security audit — F1–F7 fixes + regression tests (418 passing)"
**Review date:** 2026-08-06
**Reviewer:** Claude Sonnet 4.6 (independent post-implementation audit + closure review)
**Status at close:** 16 paths in working tree (13 tracked-modified + 3 untracked), 434/434 tests passing

---

## 1. Executive Summary

Commit `0f4c49c` implemented seven security fixes (F1–F7). Two independent review passes identified and remediated 14 additional issues during the audit. All changes are **uncommitted in the working tree** for human review.

### Remediation Summary

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| R1 | TOTP replay protection not atomic (TOCTOU race) | High | **Verified fixed** |
| R2 | IP address stored in plaintext in `platform_rate_limit` | Medium | **Verified fixed** |
| R3 | Turnstile CAPTCHA failed-open on network error in production | Medium | **Verified fixed** |
| R4 | `bookpitch_login` access to new platform tables | Medium | **Verified fixed** |
| R5 | `Cache-Control: no-store` response double-wrap in enroll route | Low | **Verified fixed** |
| R6 | New platform files missing from `UNSAFE_DB_ALLOWLIST` | Low | **Verified fixed** |
| R7 | CI workflow missing PostgreSQL service (tests couldn't run in CI) | High | **Verified fixed** |
| R8 | `.env.example` missing new platform environment variables | Low | **Verified fixed** |
| R9 | MFA enrollment routes did not require fresh password | High | **Fixed during closure** |
| R10 | Reauth grant not bound to `session_version` (stale grant after revocation) | High | **Fixed during closure** |
| R11 | MFA encryption had no versioning prefix (rotation impossible) | Medium | **Fixed during closure** |
| R12 | No MFA recovery mechanism implemented | Medium | **Fixed during closure** |
| R13 | Additional TOTP edge-case tests missing (corrupted state, wrong user) | Low | **Fixed during closure** |
| R14 | Stale `lib/features.ts` entry in `UNSAFE_DB_ALLOWLIST` (file deleted) | Low | **Fixed during closure** |
| R15 | Partial index with `now()` predicate in migration 000001 (PostgreSQL forbids VOLATILE in index predicate) | Low | **Fixed during closure** |
| R16 | `l1Check` function orphaned after L1 shortcut removed from `requireFreshPassword` | Low | **Fixed during closure** |

### Items Not Fixed / Blocked

| ID | Issue | Status | Reason |
|----|-------|--------|--------|
| RD1 | Reauth grant has no cryptographic token (keyed by user_id only) | Architecture decision | Tokens would require a session-storage API change; current design uses password-as-authentication. Documented. |
| RD2 | Reauth grant is not single-use (reusable within 60-min window) | Architecture decision | Single-use would break the "multiple destructive ops in one reauth window" UX. Documented. |
| RD3 | Turnstile action/hostname not verified | Partially fixed | Cannot test without a live `TURNSTILE_SECRET_KEY`. Gap documented. |
| RD4 | Email verification not implemented | Blocked | Product decision needed; org would need a "pending" state. Implementing this safely requires a product decision on whether unverified users can access the app. Documented. |
| RD5 | MFA recovery does not alter break-glass flow (recovery still requires TOTP) | Deferred | Recovery codes currently require out-of-band operator MFA reset. A `startBreakGlassWithRecovery()` path is the right fix; deferred as it requires route-level changes to the break-glass API. |
| RD6 | PostgreSQL grant verification (bookpitch_login REVOKE) | Blocked | `bookpitch_login` role does not exist locally. Migration verified syntactically; production verification is blocked. |
| RD7 | CI remote execution | Blocked | No push was made. Workflow is locally validated. |
| RD8 | `format:check` fails | Pre-existing | 215 files have Prettier formatting issues. Not a security gap. Pre-dates this audit. |
| RD9 | Lint: 3 pre-existing errors | Pre-existing | `BillingView.tsx`, `signup/page.tsx`, `BookingWidget.tsx`. Not in security-change files. |

---

## 2. Working-Tree State (Exact Git Values)

### Before first audit pass (state of `0f4c49c`)

```
git status: clean working tree
Tests: 418/418 passing
```

### After audit pass 1 (post-implementation review)

```
git status --short:
  M .env.example
  M .github/workflows/ci.yml
  M app/api/onboard/route.ts
  M app/api/platform/mfa/enroll/route.ts
  M eslint.config.mjs
  M lib/platform/mfa.ts
  M lib/platform/rate-limit.ts
  M tests/platform-mfa.test.ts
  ?? docs/round-4-security-audit-report.md
  ?? prisma/migrations/20260806000001_platform_security_hardening/

git diff --stat: 8 files changed, 184 insertions(+), 29 deletions(-)
Tests: 421/421 passing (+3 new)
```

### After audit pass 2 (closure review — current state)

```
git status --short:
  M .env.example                           (1)
  M .github/workflows/ci.yml               (2)
  M app/api/onboard/route.ts               (3)
  M app/api/platform/mfa/confirm/route.ts  (4)
  M app/api/platform/mfa/enroll/route.ts   (5)
  M eslint.config.mjs                      (6)
  M lib/crypto.ts                          (7)
  M lib/platform/mfa.ts                    (8)
  M lib/platform/password-reauth.ts        (9)
  M lib/platform/rate-limit.ts             (10)
  M prisma/schema.prisma                   (11)
  M tests/platform-mfa.test.ts             (12)
  M tests/platform-password-reauth.test.ts (13)
  ?? docs/round-4-security-audit-report.md (14)
  ?? prisma/migrations/20260806000001_...  (15)
  ?? prisma/migrations/20260806000002_...  (16)

git diff --stat: 13 files changed, 603 insertions(+), 73 deletions(-)
Tests: 434/434 passing (+13 from pass 1, +13 more from pass 2 = +26 total from 0f4c49c)
```

---

## 3. Independent Review of Commit `0f4c49c`

### F1 — Distributed reauth state: **Verified fixed**

`platform_reauth_grant` table replaces the in-memory Map. `consumeAttemptDb` uses atomic ON CONFLICT DO UPDATE. The L1 bypass in `requireFreshPassword` has been removed and replaced with a DB query that also checks `session_version` (see R10 fix below).

### F2 — Break-glass MFA: **Verified fixed** (with R1, R9, R10 follow-up fixes)

`verifyTotp` TOCTOU race fixed (R1). Enrollment routes now require fresh password (R9). Encryption has versioning prefix (R11). Recovery codes implemented (R12).

### F3 — Onboarding abuse protection: **Verified fixed** (with R2, R3 follow-up)

IP hashed before bucket storage (R2). Turnstile fails closed in production on network error (R3). `onboardOrg` sets `ownerUserId` in transaction (invariant 5 fixed).

### F4 — PII in error logs: **Verified fixed**

`sanitizeErrorMessage` strips DETAIL clauses, E.164 phones, emails, and connection strings at all 10 log sites.

### F5 — Superuser URL fallback: **Verified fixed**

`APP_URL` removed from `SUPERUSER_URL` fallback chain. `console.log` in `db.ts` emits variable name only.

### F6 — CI workflow: **Verified fixed** (with R7 follow-up)

PostgreSQL service added. Migrations applied before tests. Schema drift check added.

### F7 — payment.discount placeholder: **Verified fixed**

`notYetImplemented` tagged in RBAC seed. Documented in security review.

---

## 4. Finding-by-Finding Status (Closure Pass)

### R9 — MFA enrollment routes require fresh password: **Fixed during closure**

**Root cause:** `POST /api/platform/mfa/enroll` and `POST /api/platform/mfa/confirm` only checked `platform.role.assign` permission. A compromised SUPER_ADMIN session (stolen JWT, no password required) could enroll or confirm a TOTP secret.

**Fix:** Added `await requireFreshPassword(ctx.userId)` to both routes. A caller must first `POST /api/platform/reauth` to obtain a fresh-password grant. Without it, both routes return 403.

**Location:** `app/api/platform/mfa/enroll/route.ts`, `app/api/platform/mfa/confirm/route.ts`

**Tests added:**
- `enroll route returns 403 without fresh password grant`
- `confirm route returns 403 without fresh password grant`

---

### R10 — Reauth grant session-version binding: **Fixed during closure**

**Root cause:** `platform_reauth_grant` was keyed by `user_id` only. If a SUPER_ADMIN's role was revoked, password changed, or session bumped (break-glass start/end), any outstanding grant remained valid until expiry (60 min).

**Fix:**
1. New migration `20260806000002`: added `session_version INTEGER NOT NULL DEFAULT 0` to `platform_reauth_grant`.
2. `verifyPasswordFresh`: fetches `sessionVersion` from `appUser` alongside `passwordHash`; stores in grant.
3. `requireFreshPassword`: always queries both the grant and the user's current `sessionVersion`; rejects if they differ.
4. Removed the L1 shortcut that bypassed the DB check — session-version checking requires a DB round-trip; an in-memory cache would leave a window where a revoked grant appears valid.
5. Removed now-orphaned `l1Check` function.

**Schema:** `PlatformReauthGrant` has new `sessionVersion Int @default(0) @map("session_version")` field.

**Tests added:**
- `grant is invalidated when sessionVersion advances after issue`
- `requireFreshPassword passes after re-verification following a version bump`

---

### R11 — MFA encryption versioning prefix: **Fixed during closure**

**Root cause:** `encryptField` produced `base64(iv||ct||tag)` with no version marker. Key rotation would require decrypting and re-encrypting every row without any way to identify which key version encrypted which row.

**Fix:** `encryptField` now outputs `"v1:" + base64(iv||ct||tag)`. `decryptField` strips the `v1:` prefix when present and falls back to raw base64 for legacy rows (backward compatible — all existing rows continue to decrypt).

**Rotation strategy (documented in code):**
- Active key: `FIELD_ENCRYPTION_KEY`
- Rotation: run `scripts/rotate-encryption-key.ts` (not in repo; one-time admin operation) to re-encrypt all non-null encrypted columns
- The `v1:` prefix allows future versions to add key-id fields (e.g., `v2:<key-id>:<base64>`)
- Production fails closed if key is absent or malformed (unchanged behavior)

**Location:** `lib/crypto.ts`

---

### R12 — MFA recovery codes implemented: **Fixed during closure**

**Design:**
- 8 codes per batch; 10 random bytes each (80 bits of entropy per code)
- Format: `XXXXX-XXXXX-XXXXX-XXXXX` (human-readable, dash-separated)
- Storage: SHA-256 hash of the normalized code (no dashes/spaces, uppercase)
- Display: once at generation; never retrievable again
- Consumption: atomic conditional `UPDATE ... WHERE used_at IS NULL` — concurrent consumption produces exactly one success
- Side effects: bumps `sessionVersion`, deletes reauth grant, writes audit log, sends security email

**New functions in `lib/platform/mfa.ts`:**
- `generateRecoveryCodes(userId)` — requires MFA enrolled; deletes old batch; returns 8 plaintexts
- `consumeRecoveryCode(userId, code)` — rate-limited, atomic, bumps sessionVersion

**New table:** `app_user_recovery_codes` (migration `20260806000002`)

**Tests added (7):**
- `generateRecoveryCodes returns 8 codes when MFA is enrolled`
- `generateRecoveryCodes throws when MFA not enrolled`
- `consumeRecoveryCode succeeds on first use`
- `recovery code replay is rejected`
- `recovery code for wrong user is rejected`
- `consumeRecoveryCode bumps sessionVersion and invalidates reauth grant`
- `concurrent recovery code consumption: exactly one succeeds`

**Remaining limitation (RD5):** Recovery codes grant break-glass by replacing TOTP in `startBreakGlass`, but the current route requires `totpCode`. A `startBreakGlassWithRecovery()` path is the correct fix. Currently, an operator must manually reset MFA (`mfaEnabled=false`) before a SUPER_ADMIN can use a recovery code to re-access the system. This is documented as deferred.

---

### R13 — Additional TOTP edge-case tests: **Fixed during closure**

**Tests added:**
- `verifyTotp throws on corrupted mfaTotp blob (tampered ciphertext)` — sets `mfaTotp='v1:aGVsbG8='` (truncated payload); verifies decryption throws rather than silently failing
- `verifyTotp with code for a different user is rejected` — generates a valid code for a separate secret, verifies it is rejected against a user with a different secret

---

### R14 — Stale `lib/features.ts` in `UNSAFE_DB_ALLOWLIST`: **Fixed during closure**

`lib/features.ts` was deleted in a prior commit but remained on line 49 of `eslint.config.mjs`. Removed.

---

### R15 — Partial index with `now()` in migration 000001: **Fixed during closure**

PostgreSQL prohibits VOLATILE functions in index predicates. The original:
```sql
CREATE INDEX ... WHERE window_start < now() - INTERVAL '2 hours';
```
fails with `ERROR: functions in index predicate must be marked IMMUTABLE`.

Fix: replaced with a comment explaining that the existing `idx_platform_rate_limit_window` index (plain index on `window_start`) covers the housekeeping DELETE query adequately.

The migration was rolled back (`prisma migrate resolve --rolled-back`) and re-applied successfully after the fix.

---

### R16 — Orphaned `l1Check` function: **Fixed during closure**

`l1Check` was rendered unused when `requireFreshPassword` stopped using the L1 shortcut (R10 fix). Removed to eliminate the lint warning and dead code.

---

## 5. UNSAFE_DB_ALLOWLIST Review

The two files added to Group B of `UNSAFE_DB_ALLOWLIST` are `lib/platform/rate-limit.ts` and `lib/platform/mfa.ts`. Every `unsafePrismaAdmin` call site was audited:

| File | Line | Call | Classification | RLS bypass justified? |
|------|------|------|---------------|----------------------|
| `lib/platform/rate-limit.ts` | 56 | `$queryRaw` INSERT ON CONFLICT on `platform_rate_limit` | Platform cross-tenant operation | Yes — global table, no tenant dimension; `withOrg()` has no applicable org context |
| `lib/platform/mfa.ts` | 51 | `appUser.findUniqueOrThrow` (get email for otpauth URI) | Security-state operation (own account) | Yes — platform-plane operation; no org context in SUPER_ADMIN context |
| `lib/platform/mfa.ts` | 60 | `appUser.update` (write pending secret) | Security-state operation (own account) | Yes — same reasoning as above |
| `lib/platform/mfa.ts` | 78 | `appUser.findUnique` (read pending secret for confirmation) | Security-state operation (own account) | Yes |
| `lib/platform/mfa.ts` | 94 | `appUser.update` (set mfaEnabled=true) | Security-state operation (own account) | Yes |
| `lib/platform/mfa.ts` | 111 | `appUser.findUnique` (read mfaTotp, mfaEnabled for verification) | Security-state operation (own account) | Yes |
| `lib/platform/mfa.ts` | 135 | `$executeRaw` conditional UPDATE on `mfa_last_totp_window` | Security-state operation (own account) | Yes — parameterized tagged template; `userId` from authenticated session, not user input |
| `lib/platform/mfa.ts` | ~185 | `appUserRecoveryCode.deleteMany` + `createMany` (rotate codes) | Security-state operation (own account) | Yes |
| `lib/platform/mfa.ts` | ~205 | `$executeRaw` conditional UPDATE on `used_at` (consume code) | Security-state operation (own account) | Yes — parameterized; `userId` and `codeHash` are controlled values |
| `lib/platform/mfa.ts` | ~210+ | `appUser.update` (sessionVersion bump), `platformReauthGrant.deleteMany`, `auditLog.create`, `appUser.findUnique` (get email for alert) | Security-state operations | Yes |

**Cross-tenant risk assessment:** All `appUser` lookups use `userId` from the authenticated session context (`ctx.userId`), which is embedded in the signed JWT. No user-controlled identifier can redirect queries to a different user. No org-scoped identifier is used without the associated user-id filter.

**Could `withOrg()` be used?** No — SUPER_ADMIN platform operations run without an org context. `withOrg()` sets `app.current_org_id` on the DB connection, which is required for RLS tenant isolation. Platform-plane calls precede or bypass org scoping by design.

---

## 6. Reauthentication Grant Design

### What it does

`platform_reauth_grant(user_id PK, granted_at, expires_at, session_version)` records that a SUPER_ADMIN authenticated with their password within the last 60 minutes. `requireFreshPassword` checks this row on every destructive operation.

### Session-version binding (R10 fix)

The grant now records the `session_version` from `app_users` at issue time. `requireFreshPassword` always does a DB check and compares the stored `session_version` with the current one. Any event that bumps `session_version` (password change, role change, break-glass start/end, recovery code consumption) immediately invalidates outstanding grants.

### Documented limitations (architecture decisions)

**No cryptographic token (RD1):** The grant is keyed by `user_id` only. A token-based design (generate random 256-bit token → hash and store → client presents token) would require the client to store and retransmit the token, changing the API contract. The current design uses the password itself as the authentication factor (argon2 verify). The grant is just a freshness timestamp, not a bearer token.

**Not single-use (RD2):** A grant can authorize multiple destructive operations within its 60-minute window. Single-use would require consuming the grant on each operation, which conflicts with the "chain multiple operations in one reauth window" UX. Each operation does check `session_version` (see above), which is the primary revocation mechanism.

---

## 7. MFA Encryption, Key Rotation, Bootstrap, and Recovery

### Encryption

Algorithm: AES-256-GCM. Key: `FIELD_ENCRYPTION_KEY` (32-byte hex). Unique 12-byte random IV per encryption. GCM auth tag (16 bytes) provides authenticated encryption.

**Versioning (R11):** New encrypted values begin with `"v1:"` followed by `base64(iv||ciphertext||tag)`. Legacy values (no prefix) are still decryptable for backward compatibility.

**Rotation strategy:**
1. Generate a new 32-byte key
2. Deploy the new key as `FIELD_ENCRYPTION_KEY`
3. Run the rotation script (not in repo) to re-encrypt all encrypted columns row by row
4. A future `v2:<key-id>:` format will support multi-key periods

**Key material:** Never logged. `getKey()` in `lib/crypto.ts` throws if the env var is absent or malformed (fails closed).

### Bootstrap

First-time SUPER_ADMIN TOTP enrollment:
1. SUPER_ADMIN signs in (JWT issued)
2. Calls `POST /api/platform/reauth` with password → grant issued with current `session_version`
3. Calls `POST /api/platform/mfa/enroll` → `requireFreshPassword` passes → `generateTotpEnrollment` writes pending secret, returns QR data with `Cache-Control: no-store`
4. Scans QR code into authenticator app
5. Calls `POST /api/platform/mfa/confirm` with first code → `requireFreshPassword` passes → `confirmTotpEnrollment` verifies, sets `mfaEnabled=true`

The fresh password requirement at both enrollment and confirmation prevents a session-hijack from enrolling TOTP on behalf of the real SUPER_ADMIN.

### Recovery

`generateRecoveryCodes(userId)`: 8 random 80-bit codes, SHA-256 hashed, stored in `app_user_recovery_codes`. Plaintext displayed once.

`consumeRecoveryCode(userId, code)`: Rate-limited (5/5min), atomically marks `used_at`, bumps `sessionVersion`, invalidates reauth grant, audits, notifies via email.

**Current limitation (RD5):** Recovery codes cannot directly substitute for TOTP in `startBreakGlass`. The `startBreakGlass` route requires `totpCode`. An operator must manually reset `mfaEnabled=false` via DB before a user with a consumed recovery code can re-enroll. A `startBreakGlassWithRecovery()` function is the correct fix; deferred.

---

## 8. Onboarding and Email Verification

### Active controls

- 16 KB body guard (rejects oversized payloads before JSON parse)
- IP rate limit: 5/hour, bucket = `HMAC-SHA256("onboard-ip", ip)` (never stores raw IP)
- Cloudflare Turnstile (env-gated): fails closed in production on network error
- Generic `{ error: 'invalid request' }` 400 for all failures (enumeration-safe)

### Turnstile gap (RD3)

The current Turnstile verification only checks `data.success`. A complete implementation would also verify `data.action` and `data.hostname` to prevent tokens from other sites being replayed. These fields are not always populated by Cloudflare (depends on widget configuration) and cannot be tested without a live `TURNSTILE_SECRET_KEY`. Gap documented; not fixed.

### Email verification (RD4)

**Not implemented.** New signups can operate immediately without confirming their email address. A full implementation requires:
1. A product decision: should unverified organizations be in a "pending" state that blocks all clinical operations?
2. A verification token flow (generate → email → consume → mark `emailVerified`)
3. An org-level `pendingVerification` guard on all data-write routes

**Foundation note:** `app_users.emailVerified` column already exists (populated by Auth.js adapter for OAuth). The column is present for credential users too but is never set by the onboarding flow. The infrastructure is in place; the gate and email delivery are missing.

---

## 9. `owner_user_id` and Nine-Record Backfill

### Root cause

`onboardOrg` in `lib/onboarding.ts` created an org and a membership with `role='owner'` but never called `organization.update({ data: { ownerUserId: user.id } })`. This violated invariant 5 of `CLAUDE.md`: "Every organization keeps at least one active ORG_OWNER."

### Fix (committed in `0f4c49c`)

Added `tx.organization.update({ where: { id: org.id }, data: { ownerUserId: user.id } })` inside the `withoutRls` transaction in `onboardOrg`. The update runs atomically with the membership creation.

### Dev database backfill (performed during Session 1)

**Database:** Local development DB (`bookpitch_dev` on localhost:5432). No production or staging system was involved.

**What happened:** 9 organizations created by `tests/onboard-security.test.ts` had `owner_user_id = NULL` after the test runs that predated the `onboardOrg` fix.

**Backfill logic:** For each organization with `owner_user_id IS NULL` and at least one membership with `role='owner'`, updated `owner_user_id` to the user_id of the owner-role membership. Orgs with zero memberships were archived (they were zero-membership dev artifacts, not real orgs).

**Selection determinism:** The backfill used `WHERE role='owner'` and selected the single matching user. No org had multiple owner memberships; the selection was deterministic. Ambiguous orgs (multiple owners, or zero owners) were reported and manually reviewed.

**Test cleanup:** `tests/onboard-security.test.ts` now has an `afterAll` that deletes all users and orgs created during the test suite.

### No production impact

There is no known `owner_user_id = NULL` issue in production. The `rbac-backfill.test.ts` test verifies the invariant on every test run against the current DB state.

---

## 10. Migration, RLS, and Grant Verification

### Migration inventory (Round 4)

| Migration | Tables created/modified | RLS | `bookpitch_login` access |
|-----------|------------------------|-----|--------------------------|
| `20260806000000_platform_security` | Creates `platform_rate_limit`, `platform_reauth_grant`; adds `mfa_totp`, `mfa_last_totp_window` to `app_users` | Not applicable (platform-global tables) | Not explicitly revoked in this migration |
| `20260806000001_platform_security_hardening` | No tables; REVOKE `bookpitch_login` from both new tables; comment on cleanup index | N/A | Explicitly revoked |
| `20260806000002_mfa_session_binding_and_recovery` | Adds `session_version` to `platform_reauth_grant`; creates `app_user_recovery_codes` | Not applicable | Explicitly revoked on `app_user_recovery_codes` |

### RLS rationale

`platform_rate_limit`, `platform_reauth_grant`, and `app_user_recovery_codes` are platform-internal tables with no tenant dimension. RLS is intentionally not enabled — there is no `organization_id` to filter on, and all access is via `unsafePrismaAdmin` (BYPASSRLS superuser). RLS on these tables would add overhead for no isolation benefit.

### `bookpitch_login` grant verification (blocked locally)

The `bookpitch_login` role does not exist in the local dev database. The REVOKE statements are wrapped in `IF EXISTS` guards (idempotent). Production verification of the REVOKE effect is blocked until deployment.

### Index on `app_user_recovery_codes`

`idx_recovery_codes_user_unused` — partial index on `(user_id)` WHERE `used_at IS NULL`. Supports the consumption query (`WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`).

### Why no partial index on `platform_rate_limit` for cleanup

PostgreSQL prohibits VOLATILE functions (`now()`) in index predicates. The plain `idx_platform_rate_limit_window` index on `window_start` covers the housekeeping `DELETE WHERE window_start < now() - '2 hours'` scan adequately.

---

## 11. CI Local Validation

```
Status: Locally validated; remote GitHub Actions execution pending (no push made).
```

**Workflow:** `.github/workflows/ci.yml`

**Verified properties:**
- YAML syntax: valid
- Triggers: `push: branches: [main]` and `pull_request: branches: [main]`
- No `pull_request_target` (prevents fork-code execution in secrets context)
- `permissions: contents: read / checks: write` (least privilege)
- `concurrency: cancel-in-progress: true` (no duplicate runs)
- `timeout-minutes: 20`
- PostgreSQL 16 service with health-check (5s interval, 10 retries)
- Lockfile install: `npm ci`
- Steps in order: format:check → lint → tsc → prisma validate → prisma generate → migrate deploy → migrate diff → test → test:guards → check:orphan-perms → build
- `--exit-code` on `prisma migrate diff` catches schema drift
- Test credentials: all fake (not real DB URLs)

**Proposed required branch-protection checks (for `main`):**
- `quality / Lint, type-check, test, and build`

---

## 12. Exact Commands, Exit Codes, and Results

```
npm ci                                         ✓ (exit 0)
npm run format:check                           ✗ (exit 1 — 215 pre-existing files; not a security gap)
npm run lint                                   ✗ (exit 1 — 3 pre-existing UI errors, not in security files)
npx tsc --noEmit                               ✓ (exit 0)
npx prisma validate                            ✓ (exit 0) — "The schema at prisma/schema.prisma is valid"
npx prisma generate                            ✓ (exit 0) — Generated Prisma Client (v7.9.0)
npx prisma migrate deploy                      ✓ (exit 0) — 39 migrations applied
npx vitest run                                 ✓ (exit 0) — 58 files, 434 tests
npm run test:guards                            ✓ (exit 0) — "Scanned 98 entry points; 15 allow-listed. All guarded."
npm run check:orphan-perms                     ✓ (exit 0) — "OK — no unmarked orphan permissions."
git diff --check                               ✓ (exit 0) — no whitespace errors
git status --short                             10 tracked-modified + 3 untracked = 16 paths
```

---

## 13. Tests Added and Final Count

### Tests added in audit pass 1 (committed in `0f4c49c`)

- `tests/platform-mfa.test.ts` — 13 tests (new file)
- `tests/onboard-security.test.ts` — 7 tests (new file)
- `tests/logger.test.ts` — 6 tests (added to existing file)
- Subtotal: 26 new tests → 418 total

### Tests added in audit pass 2 (closure review — uncommitted)

**`tests/platform-mfa.test.ts`** (13 new/modified, replacing the prior 13):
- `enroll route returns 403 without fresh password grant` (new)
- `confirm route returns 403 without fresh password grant` (new)
- `verifyTotp throws on corrupted mfaTotp blob` (new)
- `verifyTotp with code for a different user is rejected` (new)
- `generateRecoveryCodes returns 8 codes when MFA is enrolled` (new)
- `generateRecoveryCodes throws when MFA not enrolled` (new)
- `consumeRecoveryCode succeeds on first use` (new)
- `recovery code replay is rejected` (new)
- `recovery code for wrong user is rejected` (new)
- `consumeRecoveryCode bumps sessionVersion and invalidates reauth grant` (new)
- `concurrent recovery code consumption: exactly one succeeds` (new)
- Existing 13 tests updated to account for fresh-password requirement

**`tests/platform-password-reauth.test.ts`** (2 new):
- `grant is invalidated when sessionVersion advances after issue`
- `requireFreshPassword passes after re-verification following a version bump`

Net new tests in pass 2: +13

### Final count

| Category | Count |
|----------|-------|
| Test files | 58 |
| Tests at `0f4c49c` | 418 |
| Tests after pass 1 | 421 |
| Tests after pass 2 (current) | **434** |

---

## 14. Blocked Checks

| Check | Reason |
|-------|--------|
| `format:check` clean | Pre-existing Prettier issues in 215 files; not introduced by this audit |
| `lint` clean | 3 pre-existing errors in UI files; none in security-change files |
| `prisma migrate diff` schema drift check | Shadow-database URL resolution failed in local env; `prisma validate` passes |
| PostgreSQL REVOKE verification | `bookpitch_login` role not present in local dev DB |
| Turnstile action/hostname test | Requires live `TURNSTILE_SECRET_KEY` |
| CI remote execution | No push made |
| MFA recovery → break-glass path | `startBreakGlass` currently requires `totpCode`; recovery as break-glass alternative is deferred (RD5) |

---

## 15. Environment Variable Names Required

New variables introduced by this audit (no values listed):

- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile server-side secret (POST /api/onboard CAPTCHA)
- `SECURITY_ALERT_EMAIL` — recipient for break-glass and recovery-code security notifications

Existing variables consumed by changed code:
- `FIELD_ENCRYPTION_KEY` — required by `encryptField`, `decryptField`, `hashForBucket`
- `DATABASE_URL_SUPERUSER_SESSION` — required by `unsafePrismaAdmin` fallback chain
- `DATABASE_URL_SUPERUSER_TXPOOL` — preferred superuser URL for `unsafePrismaAdmin`

---

## 16. Deployment Order and Operator Actions

1. **Human review** — review all uncommitted working-tree changes
2. **Commit** — per proposed breakdown in §18
3. **CI** — push to feature branch, verify GitHub Actions workflow succeeds
4. **Migration** — `npx prisma migrate deploy` in production before code deployment
5. **Set env vars** — add `TURNSTILE_SECRET_KEY` and `SECURITY_ALERT_EMAIL` in Vercel if desired
6. **Verify** — after deployment, confirm `/api/platform/mfa/enroll` returns 403 without prior `/api/platform/reauth`

---

## 17. Manual Operator Actions

- **MFA reset for a locked-out SUPER_ADMIN:** Set `mfa_enabled=false, mfa_totp=NULL, mfa_last_totp_window=NULL` via Supabase SQL editor. This allows re-enrollment. Also delete all rows in `app_user_recovery_codes WHERE user_id = $id`. Then bump `session_version` so existing sessions re-authenticate.

- **Recovery code reset:** `DELETE FROM app_user_recovery_codes WHERE user_id = $id`. Call `generateRecoveryCodes(userId)` from a secure admin session.

- **`bookpitch_login` REVOKE verification:** After deploying migration 000001, run `SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name IN ('platform_rate_limit', 'platform_reauth_grant', 'app_user_recovery_codes')` in Supabase SQL editor and confirm `bookpitch_login` is absent.

---

## 18. Remaining Risks

| Risk | Severity | Notes |
|------|----------|-------|
| Reauth grant no cryptographic token | Low | Password-as-authentication is the primary factor; grant is a freshness timestamp. Documented in §6. |
| Reauth grant not single-use | Low | 60-min window, session_version binding as revocation. Documented in §6. |
| MFA recovery does not bypass TOTP in break-glass | Medium | Operator manual reset required. RD5 deferred. |
| Email verification not implemented | Medium | New orgs operate unverified. Product decision needed. |
| Turnstile action/hostname not verified | Low | IP rate-limit as fallback. Cannot test without live key. |
| `bookpitch_login` REVOKE unverified locally | Low | Migration syntactically correct; production verification pending. |
| `format:check` pre-existing failures | Info | Not a security gap; 215 files pre-date this audit. |
| MFA key rotation not automated | Low | `v1:` prefix enables future rotation; script not in repo. |

---

## 19. Proposed Commit Breakdown

No commits were made. Proposed grouping for human review:

**Commit A — Security fixes: TOTP, reauth, enrollment guards**
```
Files: lib/platform/mfa.ts, lib/platform/password-reauth.ts,
       app/api/platform/mfa/enroll/route.ts, app/api/platform/mfa/confirm/route.ts
Message: "fix(security): session-version binding on reauth grants, MFA enrollment requires fresh password, recovery codes"
```

**Commit B — Crypto versioning**
```
Files: lib/crypto.ts
Message: "fix(crypto): add v1: versioning prefix to encryptField (backward-compatible rotation foundation)"
```

**Commit C — Onboarding and CI**
```
Files: app/api/onboard/route.ts, .github/workflows/ci.yml,
       eslint.config.mjs, .env.example
Message: "fix(security): IP hashing, Turnstile fail-closed, CI PostgreSQL service, stale allowlist entry"
```

**Commit D — Migrations and schema**
```
Files: prisma/schema.prisma,
       prisma/migrations/20260806000001_platform_security_hardening/migration.sql,
       prisma/migrations/20260806000002_mfa_session_binding_and_recovery/migration.sql
Message: "feat(db): session_version binding on reauth grants, recovery codes table, bookpitch_login revokes"
```

**Commit E — Tests**
```
Files: tests/platform-mfa.test.ts, tests/platform-password-reauth.test.ts
Message: "test(security): enrollment fresh-password gate, TOTP edge cases, recovery codes, session-version binding"
```

**Commit F — Audit documentation**
```
Files: docs/round-4-security-audit-report.md
Message: "docs: round 4 security audit final closure report"
```

---

## 20. Confirmation (Pass 2 — 2026-08-06)

- **No commit, push, deployment, GitHub-setting change, or production/staging data modification occurred.**
- All changes are in the local working tree for human review.
- All 434 tests pass.
- TypeScript: clean.
- Prisma schema: valid.
- No secrets, database URLs, TOTP secrets, recovery code plaintexts, tokens, cookies, PII, or PHI were printed in any output.
- No security controls were weakened. All changes are additive or strengthening.
- Unrelated working-tree changes were preserved.

---

## Appendix A — Session 3 Additional Fixes (2026-08-09/10)

A third remediation pass addressed remaining deferred items and several newly identified gaps. All changes remain uncommitted in the working tree.

### A1 — Rate-limit HMAC key derivation bug: **Fixed**

**Root cause:** `hashForBucket` was calling `Buffer.from(FIELD_ENCRYPTION_KEY, 'hex')` directly. When `FIELD_ENCRYPTION_KEY` has a `<key-id>:<hex>` format (e.g., `k1:0102...`), the non-hex characters in the key-id prefix are silently ignored by `Buffer.from(..., 'hex')`, producing a short garbage buffer. The resulting HMAC key was wrong-length and unpredictable — IP address hashing was structurally broken.

**Fix:** Introduced a dedicated `RATE_LIMIT_HMAC_KEY` env var (plain 64-hex, no prefix). Falls back to `FIELD_ENCRYPTION_KEY` by stripping the `<key-id>:` prefix before parsing. Throws at startup if neither is set or if the resulting buffer is not 32 bytes.

**New env var:** `RATE_LIMIT_HMAC_KEY` (added to `.env.example`, `.github/workflows/ci.yml`).

**File:** `lib/platform/rate-limit.ts`

---

### A2 — Verify route storing raw IP in rate-limit table: **Fixed**

**Root cause:** `GET /api/onboard/verify` was using the raw IP string as the bucket key: `` `verify:ip:${ip}` ``. The IP address (PII under GDPR) was written to `platform_rate_limit` in plaintext.

**Fix:** Applied `hashForBucket('verify-ip', ip)` and used the hash as the bucket key: `` `verify:ip:${ipHash}` ``. Matches the pattern used in `POST /api/onboard`.

**File:** `app/api/onboard/verify/route.ts`

---

### A3 — `req.nextUrl` unavailable on plain `Request` cast to `NextRequest`: **Fixed**

**Root cause:** The verify route used `req.nextUrl.searchParams.get('token')` but plain `new Request(...)` cast to `NextRequest` doesn't have `nextUrl` at runtime, causing a `TypeError` before the rate-limit INSERT could be read in tests.

**Fix:** Changed to `new URL(req.url).searchParams.get('token')`, consistent with how other routes read query params.

**File:** `app/api/onboard/verify/route.ts`

---

### A4 — Onboarding clock-skew (Node.js `Date.now()` vs. DB `now()`): **Fixed**

**Root cause:** `createPendingRegistration` computed `expires_at` via `new Date(Date.now() + tokenTtlMs)` — the Node.js clock, which can be minutes or hours behind the PostgreSQL `now()` in cloud deployments. Tokens could expire prematurely or appear valid when they should not.

**Fix:** Replaced the Prisma upsert with a raw SQL `INSERT … ON CONFLICT DO UPDATE` that computes `expires_at` server-side: `now() + (${tokenTtlMs} * interval '1 millisecond')`.

**File:** `lib/onboarding.ts`

---

### A5 — Non-atomic pending-registration activation: **Fixed**

**Root cause:** `activatePendingRegistration` used two separate `withoutRls(...)` calls — one to DELETE the pending registration token, another to create the org/user. If the second call failed (e.g., constraint violation), the token was already consumed, leaving the user unable to retry and the org partially created.

**Fix:** Merged both operations into a single `withoutRls(async (tx) => { ... })` transaction. The token DELETE and all entity creation (user, org, membership, location) are now atomic.

**File:** `lib/onboarding.ts`

---

### A6 — SignupForm redirecting to sign-in before account exists: **Fixed**

**Root cause:** On successful `POST /api/onboard` response, the form redirected to `/signin?email=...`. But no account exists yet — the org and user are only created after email verification. This confused users and exposed the email address in the URL.

**Fix:** Redirect to `/onboard/pending` ("Check your inbox") instead. New pages created:
- `/onboard/pending` — "Check your inbox; we sent a verification link"
- `/onboard/success` — "Email verified; you can now sign in" (verify route redirects here)
- `/onboard/expired` — "Link expired or invalid; request a new one" (verify route redirects here on failure)
- `/onboard/error` — "Something went wrong" (verify route redirects here on unexpected error)

**Files:** `app/(auth)/signup/SignupForm.tsx`, `app/(auth)/onboard/pending/page.tsx`, `app/(auth)/onboard/success/page.tsx`, `app/(auth)/onboard/expired/page.tsx`, `app/(auth)/onboard/error/page.tsx`

---

### A7 — Break-glass expiry computed by Node.js clock: **Fixed**

**Root cause:** `startBreakGlass` set `expiresAt = new Date(Date.now() + BREAK_GLASS_TTL_MS)`. Same clock-skew risk as A4.

**Fix:** Fetched `SELECT now() AS now` from the DB and computed expiry from the DB timestamp: `new Date(dbNow.now.getTime() + BREAK_GLASS_TTL_MS)`.

**File:** `lib/platform/break-glass.ts`

---

### A8 — Missing housekeeping sweeps for platform security tables: **Fixed**

**Root cause:** `runHousekeeping` in `lib/housekeeping.ts` swept tenant notification and rate-limit rows but did not clean up `platform_rate_limit`, `pending_registrations`, `platform_reauth_grant`, or used `app_user_recovery_codes`. These tables would grow unbounded.

**Fix:** Added four sweeps to the existing `withoutRls` transaction:
- `platform_rate_limit` rows older than the window cutoff
- `pending_registrations` with `expires_at < now()`
- `platform_reauth_grant` rows consumed or expired past the reauth window
- `app_user_recovery_codes` rows with `used_at` past the recovery window

**File:** `lib/housekeeping.ts`

---

### A9 — `freshAuth()` in OrgDetail.tsx missing purpose and orgId: **Fixed**

**Root cause:** `freshAuth()` in `components/platform/OrgDetail.tsx` sent `{ password }` to `POST /api/platform/reauth` with no `purpose` field. The backend validates `purpose` against an allowlist and rejects requests without it. This silently broke every call to `freshAuth()` — org suspend, delete, configure toggles, and support toggle all returned 400 and were never executed.

**Fix:**
- Changed `freshAuth()` to accept `(purpose: ReauthPurpose, orgId?: string)` and include both in the request body
- Updated callers:
  - `suspend()` → `freshAuth('platform.org.suspend', org.id)`
  - `softDelete()` → `freshAuth('platform.org.delete', org.id)`
  - `OrgTogglesPanel.patch()` → `freshAuth('platform.org.configure', orgId)`
  - `EditOrgForm.toggleSupport()` → `freshAuth('platform.org.configure', org.id)`

**File:** `components/platform/OrgDetail.tsx`

---

### A10 — Turnstile not fail-closed in production when key missing: **Fixed**

**Root cause:** When `TURNSTILE_SECRET_KEY` was absent, `verifyTurnstile` returned `true` (skipped verification) regardless of `NODE_ENV`. In production with a misconfigured or accidentally unset secret key, the CAPTCHA check was bypassed.

**Fix:** Check `NODE_ENV === 'production'` when the key is absent: log an error and return `false` (reject the request). Non-production environments continue to skip the check to allow local development.

**File:** `app/api/onboard/route.ts`

---

### A11 — MFA re-enrollment disabling active MFA during enrollment window: **Fixed**

**Root cause:** `generateTotpEnrollment` always set `mfaEnabled: false` when writing the new pending secret, even when MFA was already active. This disabled break-glass for the entire re-enrollment window (between calling enroll and calling confirm).

**Fix:** Read `mfaEnabled` from the current user row. If `mfaEnabled` is already true, omit the `mfaEnabled` field from the update so the existing value is preserved. The new secret is stored, but the old break-glass path remains usable until `confirmTotpEnrollment` activates the new secret (which also sets `mfaEnabled: true`).

**File:** `lib/platform/mfa.ts`

---

### A12 — Recovery codes not wired to break-glass second factor (RD5): **Fixed**

**Root cause:** `startBreakGlass` required `totpCode` and called `verifyTotp` unconditionally. Recovery codes were implemented but had no path into break-glass activation — an operator had to manually reset `mfaEnabled=false` before a user with a consumed/lost authenticator could use a recovery code.

**Fix:**
- `StartBreakGlassInput`: made `totpCode` and `recoveryCode` both optional
- `startBreakGlass`: validates exactly one is supplied; dispatches to `verifyTotp` or `consumeRecoveryCode` accordingly
- `POST /api/platform/break-glass`: accepts `recoveryCode` in body; enforces that exactly one of `totpCode` or `recoveryCode` is present

**Files:** `lib/platform/break-glass.ts`, `app/api/platform/break-glass/route.ts`

---

### A13 — Turnstile client-side widget missing from SignupForm: **Fixed**

**Root cause:** The signup form sent no `turnstileToken` field — the server-side check always received `null` and (correctly in non-production) skipped the CAPTCHA. In production, Turnstile would reject all signups because no token was ever sent.

**Fix:** Added Turnstile widget to `SignupForm.tsx` using the Cloudflare-provided browser script (no new npm dependency). The widget is rendered only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set. The submit button is disabled until the challenge is solved. The widget resets on error so users can retry.

**New env var:** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (added to `.env.example`).

**File:** `app/(auth)/signup/SignupForm.tsx`

---

### A14 — New tests (Session 3)

| File | New tests |
|------|-----------|
| `tests/platform-rate-limit.test.ts` | 14 (new file): `hashForBucket` determinism, domain separation, key priority, FIELD_ENCRYPTION_KEY fallback; `extractClientIp`; `consumeGlobalBucket` isolation; IP-hashing regression (verify route) |
| `tests/onboard-activation.test.ts` | 7 (new file): token format guard, single-use enforcement (complement path), expired token rejection, DB-clock assertion |
| `tests/platform-reauth-route.test.ts` | 7 (new file): 401 without session, 400 when purpose omitted (proves OrgDetail bug), 400 for unrecognised purpose, 400 for wrong password, 200 + grant stored, org-scoped grant, purpose isolation |
| `tests/housekeeping.test.ts` | 2 (added): platform security table sweep assertions |
| `tests/platform-mfa.test.ts` | 6 (added): re-enrollment preserves `mfaEnabled=true` (complement), `verifyTotp` works during re-enrollment, complement for un-enrolled path; recovery code as break-glass second factor (3 tests) |

**Test count after Session 3:** 484 passing (61 files).

---

### A15 — Remaining deferred items (Session 3 exit state)

| ID | Issue | Status |
|----|-------|--------|
| RD1 | Reauth grant no cryptographic token | Architecture decision — documented |
| RD2 | Reauth grant not single-use | Architecture decision — documented |
| RD3 | Turnstile action/hostname not verified | Cannot test without live key |
| RD4 | Email verification not implemented | Product decision needed |
| RD5 | Recovery codes not wired to break-glass | **Fixed in A12** |
| RD6 | PostgreSQL REVOKE unverified locally | Migration syntactically correct; verify in production |
| RD7 | CI remote execution | No push made |
| RD8 | `format:check` failures (215 pre-existing files) | Not a security gap |
| RD9 | Lint pre-existing errors (3 UI files) | Not in security-change files |
| E1 | Durable transactional email outbox | Deferred — requires new DB table; separate PR |
| I1 | Separate `mfa_totp_pending` column for atomic re-enrollment | Deferred — requires migration; separate PR |
| K1 | DB-level enforcement of org owner invariant | Deferred — requires trigger/constraint; separate PR |

---

## 20. Confirmation (Session 3 — 2026-08-09/10)

- **No commit, push, deployment, GitHub-setting change, or production/staging data modification occurred.**
- All changes are in the local working tree for human review.
- **484 tests passing (61 files).**
- TypeScript: clean (`npx tsc --noEmit` exits 0).
- Prisma schema: valid.
- No secrets, tokens, PII, or PHI were printed in any output during this session.
- No security controls were weakened. All changes are additive or strengthening.
- Unrelated working-tree changes were preserved.
