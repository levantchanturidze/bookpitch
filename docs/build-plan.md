# Bookpitch — build plan (product surface to milestone)

Updated as items complete. Ground truth is the code; spec sections cited only
where there's a gap between spec and code.

**Milestone:** SUPER_ADMIN creates org on /platform → invites owner →
owner accepts, signs in, adds staff + services, books and completes an
appointment → full onboarding chain proven in production.

Ordered by what unblocks real-clinic onboarding soonest.

---

## P0 — must ship before milestone

### P0.1 Deploy Resend email to production ✅ 2026-08-10
`lib/messaging/email/resend.ts` built and wired via `EMAIL_PROVIDER` env.
`RESEND_API_KEY`, `RESEND_FROM`, `EMAIL_PROVIDER=resend` now on Vercel
Production and Preview. Resend adapter already fails gracefully (email
error caught and logged; invitation URL still returned to caller).
**Action:** commit + push → Vercel auto-deploy.

### P0.2 Verify end-to-end onboarding in production ⚠️ NOT PRODUCTION VERIFIED

> **Status downgraded 2026-08-23 (Phase 17).** The ✅ below records a genuine
> 2026-08-10 verification, but it was invalidated by P15-010: production's
> `FIELD_ENCRYPTION_KEY` was missing its `<key-id>:` prefix, so every signup
> returned HTTP 500. The key was corrected on 2026-08-22 (deployment
> `dpl_je5rKC33RkPs9MuRfFzq6xYLL5aG`, SHA `5c8fb77`) and the resulting
> deployment has never been exercised.
>
> Measured read-only against production on 2026-08-23: **zero** ciphertext rows
> in all six encrypted locations, zero pending registrations, zero outbox rows,
> newest user/org/appointment all 2026-08-12, newest audit row 2026-08-15. The
> encryption path has not run since the correction, so there is no evidence
> either way.
>
> It cannot be probed synthetically: `/api/onboard` requires a real Turnstile
> solve and the E2E credential is inert against a production `APP_URL` by
> design, while `/api/health/ops` returns 401 with the CRON_SECRET available
> locally. See `docs/phase-17-stabilization-ledger.md` §13.
>
> **Restore the ✅ only on genuine proof** — a real signup observed reaching
> `/onboard/success`, or the production monitor reporting a healthy
> `production-config-invalid` check once Actions billing is restored.

#### Original 2026-08-10 verification (superseded)
Trace path:
1. Sign in as SUPER_ADMIN → /platform/orgs/new
2. Fill form (org name, vertical, owner email) → copy invitation URL
3. Visit /invite?token=... → set name + password → /signin
4. Sign in as new owner → /scheduler (empty state OK)
5. /settings/staff → add a staff member with availability
6. /settings/services → add a service
7. /patients → add a patient (customer)
8. /scheduler → create appointment → mark completed
Done when step 8 lands without a 4xx/5xx.

---

## P1 — blocks real-clinic use (do after milestone if not done during)

### P1.1 Resend verified domain for any-recipient email ✅ 2026-08-12
`send.bookpitch.ge` verified on Resend. DKIM + SPF + DMARC records in
Vercel-managed DNS. `RESEND_FROM` updated to
`Bookpitch <no-reply@send.bookpitch.ge>`. External delivery confirmed:
invitation to `bookpitch-deploy-test@mailinator.com` delivered, accepted,
and signed in as ORG_OWNER.

### P1.2 Ownership-transfer UI ✅ 2026-08-11
`/settings/ownership` page added. Nominee sees incoming pending transfers
with Accept/Decline; nominator sees outgoing with Revoke. `OwnershipPanel`
client component + Ownership tab in settings nav.

### P1.3 Member invitation from within the org (staff invite flow) ✅ 2026-08-11
Invite form on `/settings/members` verified end-to-end in production.
Invited `practitioner@demo.test`, accepted invitation, signed in as
PROVIDER with `302 → /` and session showing `roleKey: PROVIDER`.

### P1.4 Staff availability gating at booking time ✅ 2026-08-11
`assertWithinAvailability` returns `{"error":"slot_outside_availability"}`
(400) when slot falls outside configured window. No-window-for-day falls
through (unrestricted) by design. Readable error confirmed, no 500.

---

## P2 — clinic operations (after milestone)

### P2.1 Audit log CSV export from org audit page ✅ 2026-08-11
`GET /api/audit/export` returns up to 5000 rows as `text/csv`, accepts
the same filter params as the audit page. Export CSV button added to
`AuditView` building URL from active filters.

### P2.2 Add insurer UI for insurance claim export ✅ 2026-08-11
`insurerName` + `insurancePolicyNumber` added to `CustomerDto` +
`CustomerUpdateInput` + `buildUpdateData`. `InsurancePage` renders
`AddInsurerForm` — owner selects patient from dropdown, sets insurer
name + policy number, PATCHed to `/api/customers/[id]`.

### P2.3 Public booking widget — publicSlug on locations ✅ 2026-08-11
`publicSlug` field added to `LocationForm` with auto-sanitization to
`[a-z0-9-]`. Table shows `/book/[slug]` link when set. Backend
(`lib/admin.ts`) parse + write already done; `page.tsx` maps the field.

### P2.4 Weekly audit-digest email (cron) ✅ 2026-08-11
`cron.yml` schedule `0 8 * * 1` → `POST /api/cron/audit-digest`
authenticated by `CRON_SECRET`. `buildDigest` + `renderDigestText`
unit-tested (2 pass). `sendDigestToOwners` uses `role: 'owner'` filter
which remains correct. No code changes needed.

### P2.5 DSR/privacy panel — customer picker flow ✅ 2026-08-11
`POST /api/customers/[id]/export` + `POST /api/customers/[id]/anonymize`
both guarded by `client.export`. `PrivacyView` customer picker triggers
download / anonymize with confirm. `gdpr.test.ts` covers all three paths
(export bundle, anonymize PII redaction, retention tick). 7 tests pass.
No code changes needed.

---

## Out of scope (per working rules)

- SMS (smsoffice): stubs exist, no API key, not blocking anything.
- Payments (Stripe): no keys, no plan chosen. `BillingPanel` is read-only.
- Commission tracking, refunds, shift close, rooms/resources, integrations:
  all marked `notYetImplemented` in rbac-seed.ts; no code to build.
- Assistant (Gemini): works; no action needed.

---

## Removed / already resolved

- SEC-001 through SEC-009: closed, probes green.
- MFA re-enrollment disabling active MFA (A11): fixed.
- Recovery codes not wired to break-glass (A12): fixed.
- Turnstile client-side widget missing from signup (A13): fixed.
- RATE_LIMIT_HMAC_KEY not set in production: added to Vercel.
- Resend adapter missing: built (`lib/messaging/email/resend.ts`).
