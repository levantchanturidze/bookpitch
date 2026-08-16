# Bookpitch — capability inventory (English)

What the codebase actually does today, grounded in files. Every entry cites a
route handler, server action, service, cron, webhook, DB trigger, or UI page.
Roles are the RBAC role keys from `prisma/rbac-seed.ts`; scope reflects the
grant qualifier (`:own`, `:branch`, `:org`, or `platform`).

Compiled 2026-08-05 from `main`.

## Bookings

| Capability | File | Roles | Scope |
|---|---|---|---|
| List the active location's month of appointments (server-render for scheduler) | `app/(app)/scheduler/page.tsx` | Any with `booking.read` | `own`/`branch`/`org` per grant |
| List appointments via JSON API (filter by `locationId`, `from/to`) | `app/api/appointments/route.ts` GET | Same | Same; `:own` callers filtered by `staff.userId = caller` in-query |
| Create an appointment (with exclusion-constraint double-book guard) | `app/api/appointments/route.ts` POST + `components/scheduler/actions.ts::bookAppointmentAction` | `booking.create` | Any org member with the perm |
| Update an appointment (reschedule / restaff / re-service / notes / ICD-10) | `app/api/appointments/[id]/route.ts` PATCH + `components/scheduler/actions.ts::updateAppointmentAction` | `booking.update` — per-resource `ownerUserId` for `:own` | Enforced by `resolveBookingOwner` from `lib/rbac/scope.ts` |
| Cancel an appointment (status flip; frees the exclusion slot) | Same PATCH path with `{status:'cancelled'}` | Same | Same |
| Auto-notify the waitlist when a slot is freed | `lib/waitlist.ts::notifyWaitlistForCancelled` (inlined in the appointment PATCH tx) | System — runs on cancel transition | Org-scoped by tx |
| AI-drafted appointment note (Gemini) | `app/api/assistant/draft/route.ts` POST + `components/scheduler/actions.ts::draftAppointmentAction` | `client.read:contact` | Org; monthly per-org cap via `ASSISTANT_MONTHLY_CAP_PER_ORG` |
| Add a customer to the waitlist | `app/api/waitlist/route.ts` POST + `lib/waitlist.ts::addToWaitlist` | `booking.create` | Org |
| List the waitlist (filtered by `:own` / `:branch` scope) | `app/api/waitlist/route.ts` GET + `app/(app)/waitlist/page.tsx` | `booking.read` | `own` staff-ids OR branch locations |
| Remove a waitlist entry | `app/api/waitlist/[id]/route.ts` DELETE | `booking.update` — per-resource owner via `resolveWaitlistOwner` | Same |
| Prevent double-booking at the DB layer | `prisma/migrations/20260721220810_init/migration.sql` — `EXCLUDE USING gist (staff_id, tstzrange(starts_at, ends_at))` | Postgres constraint | Applies to non-cancelled rows |
| Enforce staff availability at booking-time | `lib/appointments.ts::assertWithinAvailability` (called by both create + update paths) | Any writer | `staff_availability` rows govern |

## Public booking widget

| Capability | File | Roles | Scope |
|---|---|---|---|
| Render a per-location public booking page (staff + services list, slot picker) | `app/book/[slug]/page.tsx` + `lib/public-booking.ts::getPublicLocation` | Anonymous | Per `Location.publicSlug` |
| Submit an anonymous booking | `app/api/public/book/route.ts` POST + `lib/public-booking.ts::submitPublicBooking` | Anonymous | 30 bookings / minute per-org rate limit |
| Reuse an existing customer row by (org, email) or (org, phone) | Same | System | Never leaks identity across orgs |
| Write a `source: 'public_widget'` audit row | `lib/public-booking.ts:171` | System | Actor null |

## Clients (customers / patients)

| Capability | File | Roles | Scope |
|---|---|---|---|
| List all customers (decrypts sensitive fields at render time) | `app/(app)/patients/page.tsx` | `client.read:contact` | Org |
| List customers via JSON API | `app/api/customers/route.ts` GET | Same | Org |
| Create a customer (encrypts `allergies` / `clinicalNotes` at rest) | `app/api/customers/route.ts` POST + `components/patients/actions.ts::createCustomerAction` | `client.create` | Org |
| Update a customer | `app/api/customers/[id]/route.ts` PATCH + `updateCustomerAction` | `client.read:contact` | Org (RLS via `withOrg`) |
| Read one customer (decrypted) | `app/api/customers/[id]/route.ts` GET | `client.read:contact` | Org |
| Delete a customer (blocks with 409 if appointments exist) | `app/api/customers/[id]/route.ts` DELETE + `deleteCustomerAction` | `client.merge` | Org |
| Add a treatment-history note | `app/api/customers/[id]/history/route.ts` POST + `addTreatmentHistoryAction` | `client.read:full` | Org |
| Export a single customer's full record as JSON attachment | `app/api/customers/[id]/export/route.ts` POST + `lib/gdpr.ts::exportCustomerData` + `exportCustomerAction` | `client.export` | Org; writes an audit row with `{export:true}` |
| Anonymize a customer (redact PII in place; keeps FK integrity) | `app/api/customers/[id]/anonymize/route.ts` POST + `lib/gdpr.ts::anonymizeCustomer` + `anonymizeCustomerAction` | `client.export` | Org; body: `{reason:'gdpr'|'retention'|'admin'}` |
| Encrypt allergies + clinical notes at rest (AES-256-GCM) | `lib/crypto.ts` via `FIELD_ENCRYPTION_KEY` | System | Row-level |

## Staff and members

| Capability | File | Roles | Scope |
|---|---|---|---|
| List staff records for the org | `app/api/admin/staff/route.ts` GET + `app/(app)/settings/staff/page.tsx` | `staff.update` | Org |
| Create a staff record | `app/api/admin/staff/route.ts` POST + `createStaffAction` | `staff.update` | Org |
| Update a staff record | `app/api/admin/staff/[id]/route.ts` PATCH + `updateStaffAction` | `staff.update` | Org |
| Delete a staff record (blocks with 409 on active bookings) | `app/api/admin/staff/[id]/route.ts` DELETE + `deleteStaffAction` | `staff.deactivate` | Org |
| Set a staff member's weekly availability windows | `app/api/admin/staff/[id]/availability/route.ts` PUT + `setAvailabilityAction` + `lib/admin.ts::setAvailability` | `staff.schedule.manage` (with per-row owner check via `resolveBookingOwner` shape) | `own` for the linked user, else `org` |
| List org members (people with logins) | `app/api/admin/members/route.ts` GET + `app/(app)/settings/members/page.tsx` | `staff.invite` | Org |
| Invite a member (creates an invitation row + optional email) | `lib/invitations.ts::createInvitation` + `inviteMemberAction` | `staff.invite` + rank check (`canManageRoleAssignment`) | Org |
| List / send / revoke invitations | `app/api/invitations/route.ts` GET/POST + `app/api/invitations/[id]/route.ts` DELETE | `staff.invite` | Org |
| Accept an invitation (creates the user OR promotes existing) | `app/api/invitations/accept/route.ts` POST + `lib/invitations.ts::acceptInvitation` | Anonymous with valid token | Org |
| Change a member's role | `app/api/admin/members/[id]/route.ts` PATCH + `updateMemberRoleAction` | `staff.role.assign` + rank guardrails (last-owner, above-rank refusal) | Org |
| Remove a member | `app/api/admin/members/[id]/route.ts` DELETE + `removeMemberAction` | `staff.deactivate` + rank + last-owner protection | Org |
| Nominate ownership transfer to another member | `app/api/admin/ownership-transfer/route.ts` POST + `lib/admin/ownership-transfer.ts::nominateTransfer` | `org.ownership.transfer` | Org |
| List pending transfers for the nominee | `app/api/admin/ownership-transfer/route.ts` GET | Session user | Own inbox |
| Accept an ownership transfer (atomically swaps roles + bumps sessions) | `app/api/admin/ownership-transfer/[id]/accept/route.ts` POST | Nominee only (WHERE-clause enforced) | Cross-org by nature |
| Decline an ownership transfer | `app/api/admin/ownership-transfer/[id]/decline/route.ts` POST | Nominee only | Same |
| Revoke a pending nomination | `app/api/admin/ownership-transfer/[id]/route.ts` DELETE | Nominator only | Same |
| Last-ORG_OWNER protection (spec §9 rule 1) | `lib/admin/last-owner.ts::assertNotLastOwner` | Guard | Called from `updateMemberRole`, `removeMember`, `acceptTransfer` |

## Services and locations

| Capability | File | Roles | Scope |
|---|---|---|---|
| List services | `app/api/admin/services/route.ts` GET + `app/(app)/settings/services/page.tsx` | `service.manage` | Org |
| Create a service | `app/api/admin/services/route.ts` POST + `createServiceAction` | `service.manage` | Org |
| Update a service | `app/api/admin/services/[id]/route.ts` PATCH + `updateServiceAction` | `service.manage` | Org |
| Delete a service | `app/api/admin/services/[id]/route.ts` DELETE + `deleteServiceAction` | `service.manage` | Org |
| List locations | `app/api/admin/locations/route.ts` GET + `app/(app)/settings/locations/page.tsx` | `org.branch.manage` | Org |
| Create a location | `app/api/admin/locations/route.ts` POST + `createLocationAction` | `org.branch.manage` | Org |
| Update a location (name/type/timezone/taxRate) | `app/api/admin/locations/[id]/route.ts` PATCH + `updateLocationAction` | `org.branch.manage` | Org |
| Delete a location (blocks with 409 on dependents) | `app/api/admin/locations/[id]/route.ts` DELETE + `deleteLocationAction` | `org.branch.manage` | Org |
| Switch the active location (server-action cookie set) | `components/shell/actions.ts::setActiveLocationAction` | Session user | Own session |
| Location → Branch sync trigger (Phase 2 backfill) | `prisma/migrations/20260728000100_rbac_sync_triggers/migration.sql` — `locations_rbac_sync_{insert,update,delete}` | DB triggers | Auto-maintain `branches` mirror |

## Payments

| Capability | File | Roles | Scope |
|---|---|---|---|
| Start a card checkout (creates payment row, redirects to gateway HPP) | `app/api/payments/checkout/route.ts` POST + `components/billing/actions.ts::startCardCheckoutAction` + `lib/payments/service.ts::startCardCheckout` | `payment.charge` | Org |
| Record a cash payment (marks appointment paid immediately) | `app/api/payments/cash/route.ts` POST + `components/billing/actions.ts::settleCashAction` + `lib/payments/service.ts::settleCash` | `payment.charge` | Org |
| Payment gateway webhook (source of truth for card outcomes) | `app/api/webhooks/payment/route.ts` POST + `lib/payments/service.ts::applyWebhook` | Anonymous (HMAC verified) | System |
| Verify webhook signature per configured gateway | `lib/payments/gateway.ts::getGateway().verifyWebhook` | System | Configurable via `PAYMENT_GATEWAY` (currently `mock`, extensible) |
| Enforce front-desk discount ceiling | `lib/payments/service.ts:244` reading `ctx.orgToggles.frontdeskDiscountCeiling` | Runtime check | Rejects discounts above the org's ceiling |
| Post-payment redirect landing page | `app/(app)/billing/return/page.tsx` | `payment.charge` | Renders current DB status |
| Mock gateway hosted-payment page (dev only) | `app/dev/mock-gateway/pay/page.tsx` + `app/dev/mock-gateway/pay/actions.ts` (approve/decline actions) | Anonymous; hidden in prod via `PAYMENT_GATEWAY=mock` check | System |
| Billing list (appointments + their latest payment) | `app/(app)/billing/page.tsx` | `payment.charge` | Active location, last 30 days |

## Subscription billing (Stripe)

| Capability | File | Roles | Scope |
|---|---|---|---|
| Show current subscription plan + period end | `app/(app)/settings/billing/page.tsx` + `lib/billing/service.ts::getBilling` | `org.billing.read` | Org |
| Start a plan checkout via Stripe Checkout Session | `app/api/billing/checkout/route.ts` POST + `lib/billing/service.ts::startCheckout` | `org.billing.manage` | Org |
| Stripe webhook → apply subscription event to org row | `app/api/webhooks/stripe/route.ts` POST + `lib/billing/service.ts::applySubscriptionEvent` | Anonymous (Stripe signature verified) | Maps to org via `stripe_customer_id` or metadata |
| Read-only billing panel on platform OrgDetail (plan / status / period-end / Stripe deep-links) | `components/platform/OrgDetail.tsx::BillingPanel` | Any platform role via `platform.analytics.read` | Platform |

## Reporting and analytics

| Capability | File | Roles | Scope |
|---|---|---|---|
| Analytics page — revenue / rating / capacity + daily roster | `app/(app)/analytics/page.tsx` + `lib/analytics.ts::computeMetrics`, `dailyRoster` | `report.branch` | Active location |
| Insurance-claim CSV export (completed appointments with ICD-10 for insured customers) | `app/api/insurance/export/route.ts` GET | `report.export` | Org; filter by insurer |
| List insurers | `app/api/insurance/insurers/route.ts` GET + `app/(app)/settings/insurance/page.tsx` | `service.manage` | Org |
| Audit log viewer (owner-only, filterable by actor/customer/action/date) | `app/(app)/audit/page.tsx` + `lib/audit-query.ts::queryAudit` | `audit.read` | Org; reads via replica (`withOrgReplica`) |
| Weekly audit-digest email to org owners | `app/api/cron/audit-digest/route.ts` POST + `lib/audit-digest.ts::runDigestForAllOrgs` | Cron (bearer `CRON_SECRET`) | All orgs; sends to every ORG_OWNER |

## Reminders and messaging

| Capability | File | Roles | Scope |
|---|---|---|---|
| Send reminders for all due appointments (cron) | `app/api/cron/reminders/route.ts` POST + `lib/messaging/reminders.ts::runReminderTick` | Bearer `CRON_SECRET`; per-org fan-out | Every org |
| Send reminder now for a specific appointment | `app/api/reminders/send-now/route.ts` POST + `sendNowAction` + `lib/messaging/reminders.ts::sendNowForSession` | `booking.update` (per-resource `ownerUserId` check) | Own bookings or wider |
| Configure reminder lead-hours per org | `saveLeadHoursAction` + `organizations.reminderLeadHours` column | `org.settings.update:org` | Org |
| Configure SMS + email templates per org | `saveTemplateAction` + `MessageTemplate` table | `org.settings.update:org` | Org |
| Render templates with `{PatientName}`, `{StaffName}`, `{ServiceName}`, `{Date}`, `{Time}` | `lib/messaging/templates.ts::renderTemplate` | System | Per-send |
| SMS via SMS Office (Georgian carrier) or mock | `lib/messaging/sms/smsoffice.ts`, `lib/messaging/sms/mock.ts` — chosen via `SMS_PROVIDER` env | System | System |
| Email via Postmark or mock | `lib/messaging/email/postmark.ts`, `lib/messaging/email/mock.ts` — chosen via `EMAIL_PROVIDER` env | System | System |
| Message-log write per attempt (queued/sent/failed) | `lib/messaging/reminders.ts:88, 107, 131, 159` | System | Includes `toAddress` + rendered `body` |
| Idempotent per (appointment, channel) — skip if already sent | `lib/messaging/reminders.ts::alreadyReminded` | System | Uses `message_log` state |

## In-app notifications

| Capability | File | Roles | Scope |
|---|---|---|---|
| Persist a notification row (from any code path) | `lib/notifications.ts::notifyEvent` | System | Per-org |
| Header-bell polls unread count (30s) | Client hook + `app/api/notifications/route.ts` GET | Session user | Own org |
| Mark all read | `app/api/notifications/mark-all-read/route.ts` POST | Session user | Own org |
| Clear all | `app/api/notifications/clear/route.ts` POST | Session user | Own org |
| Web Push subscription registration | `app/api/push/subscribe/route.ts` POST + `lib/push.ts::saveSubscription` | Session user | Per-user, cross-org |
| Web Push unsubscribe | `app/api/push/unsubscribe/route.ts` POST + `lib/push.ts::removeSubscription` | Session user | Same |
| Send Web Push to a userId (with dead-subscription cleanup) | `lib/push.ts::pushToUser` | System | Uses VAPID keys |
| Notification fired: reminder sent (SMS/email) | `lib/messaging/reminders.ts:152` — `${customer.name} · ${serviceName}` body | System | Org |
| Notification fired: payment received (card or cash) | `lib/payments/service.ts:143, 211` | System | Org |
| Notification fired: new public booking | `lib/public-booking.ts:181` | System | Org |
| Notification fired: waitlist match on cancellation | `lib/waitlist.ts:150` | System | Org |
| Notification fired: customer anonymized | `lib/gdpr.ts:184` — carries the previous name | System | Org |
| Notification fired: ownership nomination received | `lib/admin/ownership-transfer.ts:84` | System | Target org |
| Notification fired: platform impersonation started on your org | `lib/platform/impersonation.ts:118` | System | Target org |

## Data protection (GDPR / Georgian DP law)

| Capability | File | Roles | Scope |
|---|---|---|---|
| Data-subject-request (DSR) activity panel with SLA clock | `app/(app)/settings/privacy/page.tsx` + `lib/gdpr-queue.ts::recentDsrActivity` | `org.settings.update:org` | Org |
| DSR deadline days (env-configurable) | `DSR_DEADLINE_DAYS` env + `lib/gdpr-queue.ts::dsrDeadlineDays` | System | Global |
| Retention sweep — anonymize customers past `customerRetentionYears` | `app/api/cron/retention/route.ts` POST + `lib/gdpr.ts::runRetentionTick` | Bearer `CRON_SECRET`; nightly at 02:17 UTC | Every org |
| Configure per-org retention-years | `saveRetentionYearsAction` + `organizations.customerRetentionYears` | `org.settings.update:org` | Org |
| Trigger retention tick manually | `runRetentionTickAction` (reminders page control) | `org.settings.update:org` | Own org |
| Field-level encryption at rest for `allergies` + `clinicalNotes` | `lib/crypto.ts` using `FIELD_ENCRYPTION_KEY` (AES-256-GCM) | System | Per-row |
| Preserve audit trail across anonymization (audit rows' `previousName` retained; masked user rows kept for FK integrity) | `lib/gdpr.ts:180, 249` + audit_log FK is `ON DELETE NO ACTION` | System | Documented tension in the SEC-007 addendum |

## Platform administration

| Capability | File | Roles | Scope |
|---|---|---|---|
| List all organizations (with status summary strip: count-by-status, missing owners, recent signups) | `app/platform/orgs/page.tsx` + `components/platform/OrgList.tsx::StatusSummary` | `platform.analytics.read` | Platform |
| Create a new organization (with optional owner invite) | `app/platform/orgs/new/page.tsx` + `app/api/platform/orgs/route.ts` POST + `lib/platform/orgs.ts::createOrganization` | `platform.org.create` | Platform |
| View one organization (owner / members / branches / counts / billing panel / toggles) | `app/platform/orgs/[id]/page.tsx` + `components/platform/OrgDetail.tsx` | `platform.analytics.read` | Platform |
| Edit an organization (name / vertical / allowSupportImpersonation) | `app/api/platform/orgs/[id]/route.ts` PATCH + `lib/platform/orgs.ts::editOrganization` | `platform.org.suspend` (tier co-opted) + fresh-password re-auth for impersonation-flag flip | Platform |
| Suspend an organization | `app/api/platform/orgs/[id]/suspend/route.ts` POST + `lib/platform/orgs.ts::suspendOrganization` + `Btn` on OrgDetail | `platform.org.suspend` + reauth | Platform |
| Reactivate a suspended organization | `app/api/platform/orgs/[id]/reactivate/route.ts` POST + `reactivateOrganization` | `platform.org.suspend` | Platform |
| Soft-delete an organization (30-day grace) | `app/api/platform/orgs/[id]/soft-delete/route.ts` POST + `softDeleteOrganization` | `platform.org.delete` + reauth | Platform |
| Change organization owner (promote existing member or invite) | `app/api/platform/orgs/[id]/owner/route.ts` PATCH + `changeOrganizationOwner` | `platform.org.owner.change` | Platform |
| Send member a password-reset link (silent success on non-members) | `app/api/platform/orgs/[id]/reset-password-link/route.ts` POST + `sendPasswordResetLink` | `platform.user.password_reset` | Platform |
| View org-level feature toggles | `app/api/platform/orgs/[id]/toggles/route.ts` GET + `lib/rbac/toggles.ts::loadOrgToggles` + `OrgTogglesPanel` on OrgDetail | Any platform role via `platform.analytics.read` | Platform |
| Edit org feature toggles (writes an `org.toggles.update` audit row with before/after) | `app/api/platform/orgs/[id]/toggles/route.ts` PATCH + `updateOrgToggles` | `platform.config.manage` (SUPER only) + reauth | Platform |
| List holders of platform roles (roster) | `app/platform/roles/page.tsx` + `app/api/platform/roles/route.ts` GET + `listPlatformRoleHolders` | `platform.audit.read` | Platform |
| Assign or revoke a platform role for a user | `app/api/platform/roles/route.ts` POST + `assignPlatformRole` | `platform.role.assign` (SUPER only) + last-SUPER-ADMIN protection | Platform |
| Impersonate an org member (diagnostic; audited) | `app/api/platform/impersonate/route.ts` POST + `lib/platform/impersonation.ts::startImpersonation` | `platform.impersonate` + org's `allow_support_impersonation` flag | Cross-tenant |
| End an impersonation session | `app/api/platform/impersonate/end/route.ts` POST + `endImpersonation` | Session actor | Own session |
| RESTRICTED-during-impersonation permissions block destructive/clinical/policy ops | `lib/rbac/impersonation.ts::RESTRICTED_DURING_IMPERSONATION` | RBAC gate | 16 specific perms including `platform.config.manage` |
| Start a break-glass session (SUPER; audited; time-bound) | `app/api/platform/break-glass/route.ts` POST + `lib/platform/break-glass.ts::startBreakGlass` | SUPER_ADMIN, password re-auth + TOTP/recovery-code, ticketId required | Optional target org |
| Security alert email written to durable `email_outbox` inside the break-glass tx (housekeeping drain retries on failure) | `lib/platform/break-glass.ts::startBreakGlass` + `email_outbox` table + `lib/housekeeping.ts::drainEmailOutbox` | System | Alert lost only if DB commit itself fails |
| End a break-glass session | `app/api/platform/break-glass/end/route.ts` POST + `endBreakGlass` | Session actor | Own session |
| Break-glass session activation form + persistent banner | `app/platform/break-glass/page.tsx` + `components/platform/BreakGlassForm.tsx` + `PlatformShell` banner | SUPER_ADMIN | Platform |
| Every break-glass read writes an audit row (fail-closed if audit-write fails) | `lib/platform/api.ts::withPlatformApi` + `auditBreakGlassRead` | System | Auto-audited |
| Cross-tenant audit-log viewer with PII masking for SUPPORT_AGENT | `app/platform/audit/page.tsx` + `app/api/platform/audit/route.ts` GET + `lib/platform/audit.ts::queryPlatformAudit` | `platform.audit.read` | Platform; SUPPORT sees masked PII |
| Fresh-password verification primitive (60-second freshness window, rate-limited) | `lib/platform/password-reauth.ts::verifyPasswordFresh` + `requireFreshPassword` + `POST /api/platform/reauth` | Any authenticated user | Per-user marker |

## Auth, session, and accounts

| Capability | File | Roles | Scope |
|---|---|---|---|
| Email + password sign-in (JWT sessions, Auth.js v5) | `app/(auth)/signin/page.tsx` + `app/(auth)/signin/actions.ts` + `auth.ts::authorize` + `lib/auth/credentials.ts::validateCredentials` | Anonymous | Global |
| Self-service org signup (creates user + org + owner membership + first location atomically) | `app/(auth)/signup/page.tsx` + `app/api/onboard/route.ts` POST + `lib/onboarding.ts::onboardOrg` | Anonymous | Global |
| Sign out | `components/shell/actions.ts::signOutAction` | Session user | Own session |
| Request password reset (silent on unknown email) | `app/(auth)/reset/page.tsx` + `app/api/auth/reset/request/route.ts` POST + `lib/auth/password-reset.ts::requestPasswordReset` | Anonymous | Rate-limited |
| Consume a password-reset token (sets new hash, bumps sessionVersion) | `app/api/auth/reset/consume/route.ts` POST + `consumePasswordReset` | Anonymous with valid hashed token | Global |
| Accept an invitation (creates or promotes user; org membership added) | `app/(auth)/invite/page.tsx` + `app/api/invitations/accept/route.ts` + `acceptInvitation` | Anonymous with valid token | Target org |
| List a user's active memberships (multi-org picker feed) | `app/api/session/memberships/route.ts` GET + `lib/org-switch.ts::listUserMemberships` | Session user | Own memberships |
| Switch active org (bumps sessionVersion, forces re-sign-in with target orgId) | `app/api/session/switch/route.ts` POST + `switchActiveOrg` | Session user | Own memberships |
| Role-aware landing (SUPER→/platform, ACCOUNTANT→/analytics, MARKETING→/patients, else /scheduler) | `app/page.tsx` | Session user | Own role |
| Session revocation via sessionVersion — password change, role change, ownership transfer, org switch, platform-role assign | `auth.ts::session` callback + `lib/*::*sessionVersion: {increment: 1}*` writers | System | Per-user; 5s TTL |
| Argon2 password hashing | `@node-rs/argon2` in `credentials.ts`, `password-reset.ts`, `onboarding.ts`, `invitations.ts` | System | Global |
| Platform-plane security-alert email on SUPER/PLATFORM sign-in | `auth.ts::alertOnPlatformLogin` → `SECURITY_ALERT_EMAIL` | System | Best-effort, non-blocking |
| Middleware-level unauth redirect to `/signin` | `proxy.ts` (Next 16 Node Proxy) | Every request | Except public-path allowlist in `auth.config.ts::isPublicPath` |

## Organization settings (owner-facing)

| Capability | File | Roles | Scope |
|---|---|---|---|
| Settings shell + tabs nav | `app/(app)/settings/layout.tsx` + `components/settings/TabsNav.tsx` | `org.settings.update:org` | Org |
| Permissions/toggles panel (4 org-level toggles) | `app/(app)/settings/permissions/page.tsx` + `components/settings/PermissionsPanel.tsx` + `app/api/admin/toggles/route.ts` GET/PATCH | `org.settings.update:org` | Org |
| Toggle: provider financial reports | Column: `organizations.features.providerFinancialReports` — enforced in `lib/rbac/can.ts::toggleGrantsPermission` (SEC-008 fix 2026-08-05) grants `report.branch` + `report.financial:{branch,org}` when ON | Owner sets | Org |
| Toggle: provider access to other clinicians' notes | `organizations.features.providerClinicalNotesOthers` — enforced in `lib/rbac/can.ts::toggleGrantsPermission` grants `clinical_note.read:any` when ON; consumed by `lib/customers.ts::decideFullAccess` | Owner sets | Org |
| Toggle: front-desk full client history | `organizations.features.frontdeskClientFullHistory` — enforced in `lib/rbac/can.ts::toggleGrantsPermission` grants `client.read:full` when ON; consumed by `lib/customers.ts::decideFullAccess` (SEC-008 fix 2026-08-05) | Owner sets | Org |
| Toggle: front-desk discount ceiling (numeric) | `organizations.features.frontdeskDiscountCeiling` — enforced at `lib/payments/service.ts:244` | Owner sets | Per payment |
| Reminders configuration page | `app/(app)/reminders/page.tsx` | `booking.update`; template edit needs `org.settings.update:org` | Org |
| Privacy / DSR panel with customer picker (export / anonymize inline) | `app/(app)/settings/privacy/page.tsx` + `PrivacyView.tsx` | `org.settings.update:org` for the panel; individual actions require their own perms | Org |
| Toggle allow-support-impersonation for the org | `organizations.allowSupportImpersonation` column; edited via platform-plane `editOrganization` | `platform.org.suspend` tier | Org |

## Audit log (write-side)

| Capability | File | Roles | Scope |
|---|---|---|---|
| Append audit row (org-plane, inside caller's tx) | `lib/audit.ts::writeAudit` | System | Per-request |
| Platform-plane audit-write helper | `lib/platform/orgs.ts::writePlatformAudit` (private, per-org rows) | System | Per platform action |
| Break-glass read audit-write (fail-closed) | `lib/platform/break-glass.ts::auditBreakGlassRead` (called by `withPlatformApi` when `ctx.isBreakGlass`) | System | Per break-glass request |
| Toggle-change audit-write with full before/after in `meta` | `app/api/platform/orgs/[id]/toggles/route.ts:64` (SEC-004 fix) | System | Per toggle edit |
| Every mutation writes an audit row | 44 `writeAudit`/`auditLog.create` call sites in `lib/`, `app/api/` | System | Per mutation |
| Append-only enforcement: BEFORE UPDATE / DELETE / TRUNCATE triggers on `audit_log` (parent + every monthly partition) | `prisma/migrations/20260727170000_rbac_audit_log_append_only/migration.sql` + `20260727180000_audit_log_fk_hardening/migration.sql` | DB triggers | Applies to every role, including superuser |
| REVOKE UPDATE, DELETE FROM bookpitch_app on audit_log + all partitions | Same migrations | GRANT-level enforcement | Runtime role can't mutate |
| Monthly partition rollover — pre-create next 3 months | `app/api/cron/db-partitions/route.ts` POST + `bp_create_monthly_partition()` SQL function | Cron | Bearer `CRON_SECRET`, monthly at 01:30 UTC |
| Audit-log FK on `organization_id` / `actor_user_id` = `ON DELETE NO ACTION` | `prisma/migrations/20260727180000_audit_log_fk_hardening/migration.sql` | Constraint | Forces soft-mask for deletions |

## System, infrastructure, and health

| Capability | File | Roles | Scope |
|---|---|---|---|
| Per-connection DB health probe (three clients: app, superuser, narrow-login) | `app/api/health/route.ts` GET | Anonymous | Reports by env-var name; never leaks URL |
| Uptime + latency logging with request-id | `lib/logger.ts` + `lib/auth.ts::withApi` | System | Every request |
| Structured PII scrubbing at emit time (SEC-007 followup) | `lib/logger.ts::scrubPhi` — 20 exact PII/secret keys redacted | System | Every log line |
| Sentry hook stub (safe to wire when SDK lands) | `lib/logger.ts::sentryBeforeSend` | System | Adds orgId + requestId tags |
| Auth.js JWT + PrismaAdapter | `auth.ts` | System | Session-only DB writes via `unsafePrismaAdmin` |
| Three Postgres roles at DB layer: `bookpitch_app` (NOBYPASSRLS runtime), `bookpitch_login` (BYPASSRLS narrow-grant auth), `postgres` (superuser) | `lib/db.ts` — `prismaApp`, `prismaLogin`, `unsafePrismaAdmin` | Runtime | Env: `DATABASE_URL`, `DATABASE_URL_LOGIN`, `DATABASE_URL_SUPERUSER_TXPOOL` |
| ESLint restrict-imports on `unsafePrismaAdmin` / `withoutRls` / `prismaLogin` with allowlist | `eslint.config.mjs` — `UNSAFE_DB_ALLOWLIST` | Build-time gate | Every runtime source file |
| Server-side guard-check script (every route.ts has `requireAuthContext` unless allowlisted) | `scripts/check-guards.ts` (`npm run test:guards`) | Build-time gate | Every route.ts + page.tsx |
| RBAC enforcement per module via `RBAC_ENFORCE_MODULES` env | `lib/rbac/guard.ts::isEnforcing` + `requirePermission` | Runtime | Currently `*` (all modules) in prod |
| RLS tenant-isolation policy on 16 tables (organizations, memberships, locations, staff, services, customers, appointments, payments, message_templates, message_log, notifications, staff_availability, treatment_history, audit_log, waitlist, invitations, branches, membership_branches, ownership_transfers, rate_limit, assistant_usage) | `prisma/migrations/20260722000002_add_rls/migration.sql` + follow-up migrations | Postgres `USING (organization_id = current_org_id())` | Every query on `prismaApp` |
| RLS FORCE on every tenant table (even DB owner is subject) | Same | Postgres | Every tenant table |
| `SET LOCAL app.current_org_id` at start of every `withOrg` tx | `lib/db.ts::withOrg` | System | Per-request |
| Read replica routing (`prismaReplica`) for analytics + audit viewer | `lib/db.ts::withOrgReplica` + `DATABASE_URL_APP_REPLICA` env | System | Optional, falls back to primary |
| PG connection-pool cap per client (`PG_POOL_MAX`, default 3) | `lib/db.ts::POOL_MAX` | System | Per Prisma client |
| Transaction-pool routing for `unsafePrismaAdmin` | `DATABASE_URL_SUPERUSER_TXPOOL` (SEC-007) | System | Removes session-pool pressure |
| Rate-limit primitives (per-org, per-key) | `lib/rate-limit.ts` — used by public-book, messaging, assistant | System | DB-backed table |
| Session-version cache invalidation | `auth.ts::__clearSessionVersionCache` + `lib/auth/*::getCurrentSessionVersion` | System | 5s TTL |
| Field-encryption key rotation not automated | `FIELD_ENCRYPTION_KEY` — single key, per rotation script external | System | Manual |
| Migration deploy workflow with auto-issue on failure (assignee = repo owner) | `.github/workflows/migrate.yml` | GH Actions | On push to prisma/migrations/** or manual dispatch |
| Cron workflows fire every 15m (reminders), hourly (housekeeping), nightly 02:17 UTC (retention), weekly Mon 08:00 UTC (audit-digest), monthly 1st 01:30 UTC (db-partitions) | `.github/workflows/cron.yml` | GH Actions | Each POSTs bearer `CRON_SECRET` |
| Housekeeping cron — expires impersonation/break-glass sessions past `expires_at`; sweeps stale rate-limit rows | `app/api/cron/housekeeping/route.ts` + `lib/housekeeping.ts::runHousekeeping` | Cron | Hourly |
| Offline PWA shell page | `app/offline/page.tsx` | Anonymous | Service worker fallback |
| Web Push VAPID setup + payload send | `lib/push.ts::ensureVapid` — `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` env | System | Per-user |

## AI assistant

| Capability | File | Roles | Scope |
|---|---|---|---|
| Draft appointment / note text via Gemini | `app/api/assistant/draft/route.ts` POST + `lib/assistant/*.ts` | `client.read:contact` | Org |
| Per-org monthly cap on assistant calls | `ASSISTANT_MONTHLY_CAP_PER_ORG` env + `lib/assistant/quota.ts` + `assistant_usage` table | Runtime cap | Org-scoped |
| Model choice via env | `ASSISTANT_MODEL` env | System | Global |

---

# Built but not reachable

Code paths that exist but no user can trigger via UI or normal API flows.

- **`GET /api/dev/whoami-owner`** — `app/api/dev/whoami-owner/route.ts`. Dev-only debug endpoint that returns the caller's identity. Guarded by `requirePermission(ctx, 'org.settings.update:org')` so signed-in owners CAN hit it, but nothing in the UI links to it and it prints a plain JSON blob. Left over from Phase 1 bootstrap.
- **`app/dev/mock-gateway/pay/page.tsx`** — the mock payment gateway hosted-page. Serves only when `PAYMENT_GATEWAY=mock`; hidden with `notFound()` when the env is set to anything else. Live in dev; unreachable in prod. Approve/decline server actions exist alongside.
- **`sentryBeforeSend`** (`lib/logger.ts`) — Sentry hook wired for `beforeSend` on Sentry SDK init. The Sentry SDK is not installed. Function is exported for the day it lands; today it's called by nothing.
- **`lib/messaging/email/mock.ts`** + `lib/messaging/sms/mock.ts` — mock providers. Selected when `EMAIL_PROVIDER`/`SMS_PROVIDER` is unset. In prod both are set to real providers; the mocks exist for test + dev.
- **`prismaReplica`** (`lib/db.ts`) — read replica client. Falls back to `prismaApp` when `DATABASE_URL_APP_REPLICA` is unset. The replica is used explicitly only by the audit viewer (`app/(app)/audit/page.tsx` via `withOrgReplica`). No replica URL is currently set in prod, so it silently aliases to primary.
- **~~Analytics feature-flag hook~~** — removed 2026-08-05. `lib/features.ts` and its three FLAGS (`assistant_streaming`, `patient_booking_widget`, `insurance_codes`) had no production callers, so the whole module + its test were deleted rather than left as configuration that lies (same class as SEC-008).

# Partially built

Capabilities where the API exists without UI, or the UI exists without a working backend.

- **Insurance claim export UI vs. backend.** `/settings/insurance` page renders and calls into `lib/insurance.ts::listInsurers`. But there is no "add insurer" UI in this codebase — insurers are seeded / created via direct DB writes. The export endpoint works; adding the insurers to export against is manual.
- **Ownership-transfer UI absent.** The endpoints exist: `POST /api/admin/ownership-transfer` (nominate), `POST /api/admin/ownership-transfer/[id]/accept`, `/decline`, `DELETE /api/admin/ownership-transfer/[id]` (revoke). No UI in `/settings/members` or anywhere else surfaces them. The nominee gets an email (`lib/admin/ownership-transfer.ts:104`) and an in-app notification, but there's no page listing pending transfers for the current user to accept.
- **Waitlist page exists (`/waitlist`), waitlist-notify-customer flow doesn't.** When an appointment is cancelled, `notifyWaitlistForCancelled` marks matching entries `notified` and adds ONE aggregated in-app notification for staff (`lib/waitlist.ts:150`). It does NOT contact the customer — spec `docs/rbac-spec.md` describes this as intentional for MVP. Staff manually reach out via existing channels.
- **Subscription billing UI vs. Stripe wiring.** The read-only billing panel shows plan + Stripe IDs. Checkout endpoint `POST /api/billing/checkout` exists. Stripe webhook handler `POST /api/webhooks/stripe` exists. But without `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_ID_*` in prod, none of it does anything. Read-only view is functional; write-side is a dead code path in production.
- **Assistant streaming.** `lib/assistant/` supports draft generation. Streaming responses would require a code change; the previous dead `assistant_streaming` flag was removed.
- **Public booking widget.** The public booking widget at `/book/[slug]` exists and works. Always on when a location has a `publicSlug`; the previous dead `patient_booking_widget` flag was removed.
- **Insurance / ICD-10 fields.** ICD-10 code fields on the appointment (`icd10Code`, `icd10Description`) exist in the schema and the appointment PATCH accepts them. The insurance export uses them. Always on; the previous dead `insurance_codes` flag was removed.
- **Platform impersonation UI.** The endpoint (`POST /api/platform/impersonate`) works and is called from `components/platform/OrgDetail.tsx` via an "Impersonate" button on the members table. Session-end (`POST /api/platform/impersonate/end`) is called by the impersonation banner. But there's no UI to LIST currently-active impersonation sessions across the platform, or to revoke someone else's session — only your own.

# Referenced but missing

The one the user cares most about. Things the permissions table, spec, or UI implies exist but that no code actually enforces or provides.

**Permissions seeded in `prisma/rbac-seed.ts` with no `requirePermission` or `can()` callsite anywhere in the codebase (36 base permissions).** As of 2026-08-05, each of these is tagged `notYetImplemented: '<bundle_slug>'` in the seed file, and `scripts/check-orphan-perms.ts` (wired into `npm test`) fails CI if a future PR adds a seeded permission without either a callsite or a bundle tag — closing the "grant without check" class SEC-008 belonged to.

- `analytics.read` — spec §5 mentions analytics-tier reads; no enforcement site. `report.branch` is what actually gates `/analytics`.
- `attachment.manage`, `clinical_note.attachment.manage` — clinical note attachments are seeded as a permission but no `clinical_note_attachments` table exists and no attachment upload/download endpoint exists.
- `billing.manage`, `billing.read` — bare form. `org.billing.manage` and `org.billing.read` and `platform.billing.manage` / `platform.billing.read` are all seeded but the bare forms are dead.
- `booking.block_time:branch`, `booking.block_time:org`, `booking.block_time:own` — spec §5 has staff block-time (mark yourself unavailable outside regular schedule). **No block-time endpoint, no UI, no DB column.** Permission is seeded for a feature that doesn't exist.
- `booking.cancel:*` — spec has cancel-with-reason as distinct from update. Current implementation uses `booking.update` for the status flip. `booking.cancel:*` is seeded but nothing checks it.
- `branch.manage` — bare form. `org.branch.manage` is what's enforced.
- `clinical_note.create`, `clinical_note.read:own`, `clinical_note.read:any` — **no clinical-notes table exists.** Appointment has an unencrypted `notes` field and `icd10Code`/`icd10Description`. Customer has an encrypted `clinicalNotes` field. Neither is gated by these permissions. `RESTRICTED_DURING_IMPERSONATION` in `lib/rbac/impersonation.ts` lists all three, but no application code ever calls `requirePermission(ctx, 'clinical_note.*')`.
- `commission.manage`, `commission.read`, `staff.commission.manage`, `staff.commission.read` — staff commission is a spec §6.1 feature. **No commission columns, no commission calculation, no UI, no endpoints.** Perm bundle exists for a whole missing feature.
- `config.manage` — bare form. `platform.config.manage` is what's enforced (toggles).
- `integration.manage`, `org.integration.manage` — spec mentions integrations (probably third-party). **No integrations UI, no endpoints, no `integrations` table.**
- `org.create`, `org.delete`, `org.owner.change`, `org.suspend` — these are the platform-plane operations. The `platform.*` variants ARE enforced. The bare-org forms are dead — probably an early spec draft where org-plane owners could do these; now correctly platform-plane only.
- `ownership.transfer` — bare form. `org.ownership.transfer` is what's enforced.
- `payment.discount:limited`, `payment.discount:unlimited` — spec has FRONT_DESK discount tiers. The ceiling toggle IS enforced (`frontdeskDiscountCeiling` at `lib/payments/service.ts:244`). But there's no `requirePermission(ctx, 'payment.discount:*')` call — the ceiling is applied without checking whether the caller has the discount permission at all.
- `payment.refund` — spec §5 has refund. **No refund endpoint, no UI, no code.** Perm seeded, feature absent.
- `payment.shift.close`, `shift.close` — spec has end-of-shift cash close. **No shift-close endpoint, no UI, no `shifts` table.**
- `price.manage`, `service.price.manage` — spec has price-manage as separate from service-manage. Current implementation uses `service.manage` for everything including price. The finer-grained perms are dead.
- `platform.billing.manage`, `platform.billing.read` — platform-plane billing operations. BILLING_MANAGER role has these. **No platform billing UI, no endpoints.** The platform-side billing management is un-built.
- `report.own`, `report.payroll` — spec has reports beyond the branch-level. **Only `report.branch` is enforced anywhere** (`/analytics` and audit-log viewer). Payroll report doesn't exist as an endpoint or a UI. Own-tier report doesn't exist.
- `resource.manage:branch`, `resource.manage:org` — spec §5 mentions rooms/equipment as resources. **No `resources` table, no endpoints, no UI.**
- `role.assign` — bare form. `staff.role.assign` and `platform.role.assign` are enforced.
- `schedule.manage`, `staff.schedule.manage:org`, `staff.schedule.manage:branch` — the `:own` variant is used implicitly (via the staff availability route's owner check). `:org`/`:branch` bare forms are seeded but no route call checks them specifically at that scope.
- `settings.update` — bare form. `org.settings.update:org` is enforced.
- `user.password_reset` — bare form. `platform.user.password_reset` is enforced.

**~~Three feature flags with no gate~~ — removed 2026-08-05.** `assistant_streaming`, `patient_booking_widget`, `insurance_codes` in the deleted `lib/features.ts`. `isFeatureEnabled()` was never called; the whole module + its test went with them.

**~~Three org toggles with no runtime check~~ — fixed 2026-08-05 as [SEC-008](rbac-security-review.md#sec-008).** `providerFinancialReports`, `providerClinicalNotesOthers`, `frontdeskClientFullHistory` — now consulted in `lib/rbac/can.ts::toggleGrantsPermission` and `lib/customers.ts::decideFullAccess`. Regression probes P8.1–P8.3 in `tests/security-review.test.ts` assert response bodies actually differ on toggle flip. The fourth toggle, `frontdeskDiscountCeiling`, was already enforced at `lib/payments/service.ts:244`.

**Auth.js CallbackUrl cookie neutralized by design, not by config.** `auth.config.ts` sets the `__Secure-authjs.callback-url` cookie with `maxAge: 0` because Auth.js's own middleware sets it unconditionally. That's a workaround for framework behavior, not a documented capability — worth knowing that the cookie exists briefly on every request.

**References to `docs/rbac-spec.md` sections that describe capabilities the code doesn't implement:**

- §5 clinical-notes CRUD — permissions exist, tables don't
- §5 payment refund — permission exists, code doesn't
- §5 payment shift close — permission exists, code doesn't
- §5 staff commission — permissions exist, code doesn't
- §6.1 rooms / resources — permissions exist, code doesn't
- §6.1 SUPPORT_AGENT PII masking is real for audit-log (`app/platform/audit/page.tsx`) — no other platform surface implements it
- §7.2 break-glass 2FA — spec requires TOTP; implementation is password-only. `TODO(Phase 5 v2)` in `lib/platform/password-reauth.ts:18` acknowledges this
- Audit-log CSV export from the org-level audit viewer — spec §11 mentions it, no export button exists on `app/(app)/audit/page.tsx`
