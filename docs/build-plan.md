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

### P0.2 Verify end-to-end onboarding in production ✅ 2026-08-10
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

### P1.1 Resend verified domain for any-recipient email
Currently `RESEND_FROM=onboarding@resend.dev` only delivers to the Resend
account holder's email address (`levani.tchanturidze@gmail.com`). To reach
any owner inbox, a domain needs DNS verification on Resend.
**Action:** add domain via Resend dashboard → add DNS records →
update `RESEND_FROM` on Vercel to e.g. `noreply@bookpitch.ge`.
Not blocking milestone (URL is shown on screen in NewOrgForm).

### P1.2 Ownership-transfer UI
`POST /api/admin/ownership-transfer`, `accept`, `decline`, `DELETE` all
exist (`lib/admin/ownership-transfer.ts`). Owner nominee gets a
notification (`lib/notifications.ts`). But there is no page to list
pending transfers — the nominee has no UI to accept.
**Action:** add `/settings/ownership-transfer` (or surface on the members
page) — list transfers awaiting the current user, with Accept / Decline
buttons.

### P1.3 Member invitation from within the org (staff invite flow)
`POST /api/invitations` + `inviteMemberAction` work and send email.
`/settings/members` page lists members and shows an invite button.
Need to verify the invite form on `/settings/members` is wired and that
a staff member (not just ORG_OWNER) can accept and sign in. Flow is the
same as P0.2 step 3 but from within the org, not from /platform.

### P1.4 Staff availability gating at booking time
`lib/appointments.ts::assertWithinAvailability` is called on create +
update. Staff need at least one `staff_availability` row before
`bookAppointmentAction` will accept them. The staff panel UI has an
"Edit availability" flow (`setAvailabilityAction`). Verify this works
end-to-end in production: staff with no availability should give a
readable error, not a 500.

---

## P2 — clinic operations (after milestone)

### P2.1 Audit log CSV export from org audit page
`/audit` page renders and queries `lib/audit-query.ts`. No export button.
Spec §11 describes it. An in-browser download triggered by a GET
with `Accept: text/csv` is the simplest implementation.

### P2.2 Add insurer UI for insurance claim export
`/settings/insurance` lists insurers via `lib/insurance.ts::listInsurers`.
Insurance export endpoint works. But there is no "add insurer" form —
insurers can only be created via DB seed or manual SQL. Add a simple
POST form on the settings/insurance page.

### P2.3 Public booking widget — publicSlug on locations
`/book/[slug]` works. But locations need a `publicSlug` set. Currently
no UI surfaces the publicSlug field when creating or editing a location.
Add publicSlug to the location create / edit form in `/settings/locations`.

### P2.4 Weekly audit-digest email (cron)
`app/api/cron/audit-digest/route.ts` exists. Sends to every ORG_OWNER.
With EMAIL_PROVIDER=resend, this will now attempt real sends. Verify
the cron fires correctly (check GH Actions → cron.yml weekly run).

### P2.5 DSR/privacy panel — customer picker flow
`/settings/privacy` page + `PrivacyView.tsx` exist. DSR activity shows
up. Individual export/anonymize need `client.export` which ORG_OWNER has.
Verify the flow works with a real customer record.

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
