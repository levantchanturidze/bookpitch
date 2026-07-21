# Claude Code — Build Prompts (all phases)

Copy-paste these into **Claude Code**, one at a time, in order. Commit and verify
after each before moving to the next. They assume the recommended stack from
`ARCHITECTURE.md`: **Next.js (App Router, TS) + Prisma + Supabase (Postgres +
Auth + RLS) + a Georgian payment gateway (BoG iPay / TBC E-Commerce)**. If you
chose a different stack, adjust the stack-named steps only.

> **Golden rule:** never ask for "the whole app." One task, one commit, verify,
> next.

---

## P0 — Kickoff (run once)

```
Read ARCHITECTURE.md and schema.sql at the repo root in full before doing
anything, and treat them as the source of truth for this project.

Context: we are turning an existing AI Studio prototype (React 19 + Vite +
Tailwind — a clinic/salon booking app whose data currently lives only in
localStorage) into a production multi-tenant SaaS.

Task for now — scaffolding only, no business logic:
- Create a Next.js App Router project in TypeScript at the repo root.
- Configure Tailwind, ESLint, Prettier.
- Create the folder layout: app/, components/, lib/, prisma/.
- Copy the prototype's React components into components/ so we can port them
  next (do not rewrite them yet).
- Add a short "Project layout" section to README.md.

Confirm the plan in 3-4 bullets first, then implement, then commit.
```

---

## Phase 1 — Make it real (MVP)

### P1.1 — Database & Prisma

```
Goal: stand up the real database from schema.sql.

- Provision a Supabase Postgres project (or local Postgres) and add the
  connection string to .env (never commit it).
- Translate schema.sql into a Prisma schema that matches it exactly: same
  tables, enums, relations, and constraints.
- Prisma can't express the GiST exclusion constraint (no_staff_double_booking)
  or the RLS policies — add those via a raw SQL migration so they are applied
  by `prisma migrate`.
- Run the migration and generate the Prisma client in lib/db.ts.
- Add a seed script that creates one organization ("Grand Medical & Aurora Spa
  Group") with two locations (one clinic, one salon), the staff, services, and
  the 5 sample customers from the prototype's data.ts.

Verify: `prisma migrate` succeeds and the seed runs. Commit.
```

### P1.2 — Auth, tenancy & RBAC

```
Goal: real login and server-enforced roles (replace the prototype's role
dropdown).

- Wire Supabase Auth for email login. On sign-in, resolve the user's
  organization + role from the memberships table and expose it as request
  context (e.g. a getSession() helper in lib/auth.ts returning
  { userId, organizationId, role }).
- Enable Postgres RLS on every tenant-owned table with an organization_id
  policy (use the sketch in schema.sql). Confirm a user cannot read another
  organization's rows.
- Add a server-side requireRole(role) guard used by API routes. Roles:
  owner = all; receptionist = scheduler/customers/reminders/billing;
  practitioner = scheduler/customers.

Verify: write a quick test that a receptionist is rejected from an owner-only
endpoint, and that RLS blocks cross-tenant reads. Commit.
```

### P1.3 — Port the prototype UI

```
Goal: bring the prototype's UI into Next.js, driven by real session/role.

- Recreate the app shell: sidebar (Scheduler, Patients/Clients, Reminders,
  Billing & POS, Business Intelligence), header with the clinic/salon location
  switch, and the notification bell.
- Tab visibility follows the signed-in user's role (UI convenience only — the
  real enforcement is the server guards from P1.2).
- The clinic/salon switch selects the active location; the UI relabels
  "Patients" vs "Clients" based on location type, as in the prototype.
- No feature logic yet — just navigation and layout wired to real session data.

Verify: log in as each role and confirm the correct tabs render. Commit.
```

### P1.4 — Customers / Patients module

```
Goal: make the Patients/Clients screen real and compliant.

- Build CRUD API routes for customers + treatment_history, scoped to the
  caller's organization.
- Port the PatientDatabase component to read/write via these APIs instead of
  localStorage.
- Sensitive fields (allergies, clinical_notes) must be encrypted at rest and
  every read/write of a customer record must write an entry to audit_log
  (actor, action, entity_id).
- Add a consent capture field on the customer form (consent_at,
  consent_version).

Verify: create/edit a customer, confirm rows persist in Postgres and audit_log
gets entries. Commit.
```

### P1.5 — Scheduler & anti-double-booking (core)

```
Goal: real booking with database-guaranteed integrity.

- Build appointments API routes (create/update/cancel), scoped to the active
  location. On create: snapshot service name + price, compute ends_at from
  duration, set status/payment_status defaults.
- Validate the requested slot against staff_availability before inserting.
- Rely on the DB exclusion constraint (no_staff_double_booking) as the final
  guard; catch the constraint violation and return a clean "slot taken" error.
- Port CalendarView and the "Book Appointment" modal to these APIs.

Verify: write an automated test that two overlapping bookings for the same
staff member are rejected by the database (not just the UI). Commit.
```

---

## Phase 2 — Operations

### P2.1 — Payments (Georgian gateway)

```
Goal: replace the fake STRIPE_TX token with real settlement.

- Integrate one Georgian gateway — BoG iPay or TBC E-Commerce — using its
  Hosted Payment Page (card data never touches our servers).
- Billing & POS flow: create a payments row (status unpaid) for the selected
  appointment, redirect the user to the gateway page, and handle the return.
- Implement the gateway webhook: on success, mark the payment paid and set the
  appointment's payment_status = 'paid'. Treat the webhook as the ONLY source of
  truth for success — never the client redirect.
- Store only gateway_txn_id and status; no card data.
- Remove the prototype's cosmetic "PCI-Compliant SSL / Verified SSL SHA-256"
  footer text.

Verify: run a sandbox payment end-to-end; confirm the webhook updates both
tables. Commit.
```

### P2.2 — Reminders (real SMS + email)

```
Goal: actually send reminders (replace the fake "Dispatch -> Sent").

- Persist SMS/email templates to message_templates. Keep the {PatientName},
  {StaffName}, {ServiceName}, {Date}, {Time} placeholders.
- Add a scheduled job (cron or queue) that, X hours before each upcoming
  appointment, renders the template and sends via a Georgian SMS provider
  (SMS) and a transactional email service (email), writing each send to
  message_log with provider_msg_id and state.
- Make the reminder lead time configurable per organization.

Verify: schedule a near-future appointment, run the job, confirm a real
message is sent and logged. Commit.
```

### P2.3 — Business Intelligence (real metrics)

```
Goal: replace hardcoded dashboard numbers with real aggregates.

- Implement SQL aggregate queries for: daily revenue (+ % vs same weekday last
  week), today's bookings, staff occupancy (booked minutes / available
  minutes), average ticket value, 7-day revenue trend, and bookings-per-staff.
- Build the "Daily Staff Roster & Availability" table from staff +
  staff_availability.
- Scope everything to the active location; owner-only access.

Verify: numbers match hand-checked values against seeded data. Commit.
```

---

## Phase 3 — Polish & scale

### P3.1 — Realtime notification feed

```
Goal: turn the "Operational Log" into a live feed.

- Write notification rows on key events (appointment booked, payment confirmed,
  booking request). Stream them to the header bell via Supabase realtime (or
  websockets). Support mark-read / clear.

Verify: booking an appointment in one session shows a live notification in
another. Commit.
```

### P3.2 — PWA (installable, responsive)

```
Goal: "on the go" access without a real offline engine.

- Make the app an installable PWA: manifest, service worker caching the app
  shell, responsive layouts verified on mobile widths.
- Read-only cached view when briefly offline is fine; do NOT rebuild the
  prototype's localStorage sync engine — the cloud DB is the source of truth.

Verify: install on a phone, confirm responsive layout and app-shell load.
Commit.
```

### P3.3 — Compliance tooling

```
Goal: make the health-data handling defensible.

- Build an owner-only audit-log viewer (filter by customer, actor, date).
- Implement data-retention: a policy setting + a job that flags/anonymizes
  records past retention.
- Implement customer deletion / data-export requests (GDPR-style), writing the
  action to audit_log.

Verify: exercise each flow on a test customer. Commit.
```

### P3.4 — Multi-location administration

```
Goal: let an owner run several businesses from one account.

- Admin screens to create/edit locations, staff (+ availability windows),
  services, and to invite users with a role (memberships).
- Ensure new locations inherit the org's tenancy + RLS automatically.

Verify: create a second clinic location and confirm isolation + correct
labeling. Commit.
```

### P3.5 — (Optional) AI booking assistant

```
Goal: only if it earns its place — natural-language booking.

- Add a Gemini-powered assistant (the @google/genai dependency is already
  present) that turns "book Sarah with Dr. Vance next Tuesday afternoon" into a
  validated appointment draft the user confirms.
- Keep it server-side; reuse the same availability + double-booking rules.

Verify: a few phrasings produce correct, confirmable drafts. Commit.
```

---

## Final acceptance checklist

- [ ] No `localStorage` anywhere in the data path — Postgres is the source of truth.
- [ ] RLS blocks cross-tenant reads (proven by test).
- [ ] Server-side RBAC on every mutating endpoint.
- [ ] Double-booking rejected by the database (proven by test).
- [ ] Payments confirmed only via webhook; no card data stored.
- [ ] Reminders actually send and are logged.
- [ ] Sensitive customer fields encrypted; all access audited; consent captured.
- [ ] Secrets in env/secret manager, never committed.
```
