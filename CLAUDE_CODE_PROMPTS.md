# Claude Code — Build Prompts (all phases)

Copy-paste these into **Claude Code**, one at a time, in order. Commit and verify
after each before moving to the next.

**Stack these assume** (see `ARCHITECTURE.md`): Next.js App Router + TypeScript,
Prisma, **plain PostgreSQL on a hosted free tier in an EU region**, **Auth.js**
for authentication (no vendor auth service), Vercel for hosting, and a Georgian
payment gateway. The design goal is portability: every piece except the payment
gateway and the SMS/email provider can be swapped later.

> **Golden rule:** never ask for "the whole app." One task, one commit, verify,
> next.

---

## P0 — Kickoff (run once)

```
Read ARCHITECTURE.md and schema.sql at the repo root in full before doing
anything, and treat them as the source of truth for this project.

Context: we are turning an existing AI Studio prototype (React 19 + Vite +
Tailwind — a clinic/salon booking app whose data currently lives only in
localStorage, in ./prototype) into a production multi-tenant SaaS.

Two constraints that shape every decision:
1. Portability — no vendor lock-in. The database is plain PostgreSQL reached
   through DATABASE_URL, and auth is a library running in our own code. Do not
   introduce a platform SDK that would be hard to remove later.
2. Zero cost to start — we will run on free tiers until the product earns money.

Task for now — scaffolding only, no business logic:
- Initialize a git repository and prepare it for a private GitHub remote.
  Add a .gitignore that excludes .env and all secrets.
- Create a Next.js App Router project in TypeScript at the repo root.
- Configure Tailwind, ESLint, Prettier.
- Create the folder layout: app/, components/, lib/, prisma/.
- Copy the prototype's React components into components/ so we can port them
  next (do not rewrite them yet).
- Add a "Project layout" and "Getting started" section to README.md.

Confirm the plan in 3-4 bullets first, then implement, then commit.
```

---

## Phase 1 — Make it real (MVP)

### P1.1 — Database & Prisma

```
Goal: stand up the real database from schema.sql, on a hosted free tier.

- The database is a hosted PostgreSQL free tier (Neon or Supabase — we use it
  purely as Postgres, no platform SDK). Tell me which to create and walk me
  through it; I will create it and paste the connection string.
  IMPORTANT — data residency: this app stores health data, so the project MUST
  be created in an EU region (Frankfurt / eu-central). The region is chosen once
  at creation and usually CANNOT be changed later. Confirm the region with me
  before we continue.
- Put the connection string in .env as DATABASE_URL. Never commit it. Add
  .env.example with placeholder values.
- Translate schema.sql into a Prisma schema that matches it exactly: same
  tables, enums, relations and constraints.
- Prisma cannot express the GiST exclusion constraint
  (no_staff_double_booking) or the RLS policies — add those in a raw SQL
  migration so `prisma migrate` applies them.
- Also support an optional local Docker Postgres for throwaway experiments:
  add a docker-compose.yml and document how to point DATABASE_URL at it. The
  hosted database remains the source of truth.
- Add a seed script creating one organization ("Grand Medical & Aurora Spa
  Group") with two locations (one clinic, one salon), plus the staff, services
  and 5 sample customers from ./prototype/src/data.ts.

Verify: `prisma migrate` succeeds against the hosted DB and the seed runs.
Commit.
```

### P1.2 — Auth.js, tenancy & RBAC

```
Goal: real login and server-enforced roles, with no vendor auth service.

- Set up Auth.js (NextAuth) with the Prisma adapter, storing users and sessions
  in our own database. Email + password login. Do not hand-roll password
  hashing, session handling or reset flows — use the library's.
- On sign-in, resolve the user's organization and role from the memberships
  table. Expose a server helper getSession() returning
  { userId, organizationId, role }.
- Build a scoped data-access layer in lib/: every query takes organizationId
  from the session. Route handlers must NEVER accept an organization id from
  the request body or query string.
- Add defence in depth with RLS: open a transaction, run
  `SET LOCAL app.current_org_id = '<uuid>'`, and have policies read
  current_setting('app.current_org_id', true)::uuid. This requires the app to
  connect as a NON-OWNER database role and tables to use FORCE ROW LEVEL
  SECURITY — set both up.
- Add a server-side requireRole() guard for API routes. Roles: owner = all;
  receptionist = scheduler/customers/reminders/billing; practitioner =
  scheduler/customers.

Verify: write tests that (a) a receptionist is rejected from an owner-only
endpoint, and (b) a session scoped to org A cannot read org B's rows. Commit.
```

### P1.3 — Port the prototype UI

```
Goal: bring the prototype's UI into Next.js, driven by the real session.

- Recreate the app shell: sidebar (Scheduler, Patients/Clients, Reminders,
  Billing & POS, Business Intelligence), header with the clinic/salon location
  switch, and the notification bell.
- Replace the prototype's "Access Role" dropdown with the real signed-in user.
  Tab visibility follows their role (UI convenience only — the real enforcement
  is the server guards from P1.2).
- The clinic/salon switch selects the active location; the UI relabels
  "Patients" vs "Clients" based on location type, as in the prototype.
- For avatars, use generated initials for now — no file uploads in the MVP.
- No feature logic yet — just navigation and layout wired to real session data.

Verify: log in as each role and confirm the correct tabs render. Commit.
```

### P1.4 — Customers / Patients module

```
Goal: make the Patients/Clients screen real and compliant.

- Build CRUD API routes for customers + treatment_history, going through the
  scoped data-access layer from P1.2.
- Port the PatientDatabase component to use these APIs instead of localStorage.
- Sensitive fields (allergies, clinical_notes) must be encrypted at rest, and
  every read/write of a customer record must append to audit_log (actor,
  action, entity_id, timestamp).
- Add consent capture to the customer form (consent_at, consent_version).
- Ensure no patient names, contact details or clinical fields are ever written
  to application logs.

Verify: create and edit a customer; confirm rows persist and audit_log fills.
Commit.
```

### P1.5 — Scheduler & anti-double-booking (core)

```
Goal: real booking with database-guaranteed integrity.

- Build appointments API routes (create/update/cancel), scoped to the active
  location. On create: snapshot service name and price, compute ends_at from
  duration, set status/payment_status defaults.
- Validate the requested slot against staff_availability before inserting.
- Rely on the DB exclusion constraint (no_staff_double_booking) as the final
  guard; catch the violation and return a clean "slot taken" error.
- Port CalendarView and the "Book Appointment" modal to these APIs.

Verify: write an automated test proving two overlapping bookings for the same
staff member are rejected BY THE DATABASE, not just the UI. Commit.
```

### P1.6 — Deploy to staging

```
Goal: get the MVP on real infrastructure early (deploying late is how
deployment problems become expensive).

- Push to the private GitHub repo and connect it to Vercel.
- Deploy with the serverless region set to Frankfurt (fra1), next to the EU
  database.
- Configure environment variables in Vercel — never in the repo. Keep staging
  separate from production.
- Add a health-check route and verify login + booking work on the deployed URL.
- Note in README: this staging deployment must contain NO real patient data and
  NO real payments. Vercel's free Hobby plan is restricted to non-commercial
  use, so going commercial requires the Pro plan.

Verify: sign in on the deployed URL and complete one booking end to end. Commit.
```

---

## Phase 2 — Operations

### P2.1 — Payments (Georgian gateway)

```
Goal: replace the fake STRIPE_TX token with real settlement.

- Integrate one Georgian gateway — BoG iPay or TBC E-Commerce — using its
  Hosted Payment Page, so card data never touches our servers.
- Billing & POS flow: create a payments row (status unpaid) for the selected
  appointment, redirect to the gateway page, handle the return.
- Implement the gateway webhook: on success mark the payment paid and set the
  appointment's payment_status. Treat the webhook as the ONLY source of truth
  for success — never the client redirect. Verify the webhook signature.
- Store only gateway_txn_id and status; never card data.
- Remove the prototype's cosmetic "PCI-Compliant SSL / Verified SSL SHA-256"
  footer text.

Verify: run a sandbox payment end to end; confirm the webhook updates both
tables. Commit.
```

### P2.2 — Reminders (real SMS + email)

```
Goal: actually send reminders (replace the fake "Dispatch -> Sent").

- Persist SMS/email templates to message_templates, keeping the
  {PatientName}, {StaffName}, {ServiceName}, {Date}, {Time} placeholders.
- Add a scheduled job (Vercel Cron, or a cron route protected by a secret)
  that, X hours before each upcoming appointment, renders the template and
  sends via a Georgian SMS provider and a transactional email service, writing
  each send to message_log with provider_msg_id and state.
- Make the reminder lead time configurable per organization.
- Make sends idempotent so a re-run cannot double-send.

Verify: schedule a near-future appointment, run the job, confirm a real message
is sent and logged exactly once. Commit.
```

### P2.3 — Business Intelligence (real metrics)

```
Goal: replace hardcoded dashboard numbers with real aggregates.

- Implement SQL aggregate queries for: daily revenue (+ % vs the same weekday
  last week), today's bookings, staff occupancy (booked minutes / available
  minutes), average ticket value, 7-day revenue trend, bookings per staff.
- Build the "Daily Staff Roster & Availability" table from staff +
  staff_availability.
- Scope to the active location; owner-only access.

Verify: numbers match hand-checked values against the seeded data. Commit.
```

---

## Phase 3 — Polish & scale

### P3.1 — Notification feed

```
Goal: turn the "Operational Log" into a working feed, without a realtime
vendor.

- Write notification rows on key events (appointment booked, payment confirmed,
  booking request).
- Start with simple polling from the header bell (e.g. every 30s) — adequate
  for this workload and dependency-free.
- If and when it proves insufficient, upgrade to Server-Sent Events from a
  Next.js route. Do not add a third-party realtime service.
- Support mark-read and clear.

Verify: booking an appointment in one session surfaces a notification in
another. Commit.
```

### P3.2 — PWA (installable, responsive)

```
Goal: "on the go" access without a real offline engine.

- Make the app an installable PWA: manifest, service worker caching the app
  shell, responsive layouts verified at mobile widths.
- A read-only cached view when briefly offline is fine. Do NOT rebuild the
  prototype's localStorage sync engine — the database is the source of truth.

Verify: install on a phone; confirm responsive layout and app-shell load.
Commit.
```

### P3.3 — Compliance tooling

```
Goal: make the health-data handling defensible.

- Build an owner-only audit-log viewer (filter by customer, actor, date).
- Implement data retention: a policy setting plus a job that flags or
  anonymizes records past the retention period.
- Implement customer deletion and data-export requests (GDPR-style), writing
  each action to audit_log.
- Add a scripted database backup (pg_dump to EU-region storage) with a
  documented restore procedure, and verify a restore actually works.

Verify: exercise each flow on a test customer, and perform one full restore
drill. Commit.
```

### P3.4 — Multi-location administration

```
Goal: let an owner run several businesses from one account.

- Admin screens to create/edit locations, staff (+ availability windows) and
  services, and to invite users with a role (memberships).
- Ensure new locations inherit tenancy and isolation automatically.

Verify: create a second clinic location and confirm isolation and correct
labeling. Commit.
```

### P3.5 — (Optional) AI booking assistant

```
Goal: only if it earns its place — natural-language booking.

- Add a Gemini-powered assistant (@google/genai is already in the prototype's
  dependencies) that turns "book Sarah with Dr. Vance next Tuesday afternoon"
  into a validated appointment draft the user confirms.
- Keep it server-side and reuse the same availability and double-booking rules.
- Never send patient clinical fields to the model.

Verify: several phrasings produce correct, confirmable drafts. Commit.
```

---

## Going live (when the product earns money)

```
Goal: move off free tiers without re-architecting.

- Upgrade Vercel to Pro (the Hobby plan forbids commercial use).
- Upgrade the database to a paid tier, or migrate to another Postgres provider
  with pg_dump / pg_restore and a changed DATABASE_URL. Because Auth.js stores
  users in our own tables, no user accounts need migrating.
- Confirm automated daily backups are enabled AND that the backups are stored
  in the same EU region as the database.
- Re-check that logs, SMS/email providers and any analytics tooling comply with
  the data-residency rules in ARCHITECTURE.md section 8.
- Sign DPAs with every processor before real patient data is loaded.
```

---

## Final acceptance checklist

- [ ] No `localStorage` anywhere in the data path — Postgres is the source of truth.
- [ ] Code lives in a private GitHub repo, not only on one machine.
- [ ] Tenant isolation enforced in the data-access layer AND by RLS (proven by test).
- [ ] Server-side RBAC on every mutating endpoint.
- [ ] Double-booking rejected by the database (proven by test).
- [ ] Payments confirmed only via a signature-verified webhook; no card data stored.
- [ ] Reminders actually send, exactly once, and are logged.
- [ ] Sensitive customer fields encrypted; all access audited; consent captured.
- [ ] Secrets in env/secret manager, never committed.
- [ ] Database AND backups in the EU region; a restore drill has been performed.
- [ ] Application logs contain no patient data.
