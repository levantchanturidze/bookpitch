# Clinic & Salon Schedule Manager — Production Architecture & Build Spec

**Purpose:** promote the AI Studio prototype into a real, multi-tenant SaaS.
This document is written to be handed directly to **Claude Code** as a build
brief. Pair it with `schema.sql` (the database schema).

---

## 1. What exists today (prototype reality)

The prototype is a **React 19 + Vite + Tailwind single-page app**. The UI and the
data model (`src/types.ts`) are solid and worth keeping. Everything behind the UI
is simulated:

| Area | Prototype today | Needs to become |
|---|---|---|
| Data store | Browser `localStorage` | Real PostgreSQL database (durable, multi-device, multi-user) |
| Auth | A role dropdown ("Owner (Unrestricted)") | Real login + server-enforced RBAC |
| Tenancy | One implicit business, clinic/salon toggle | Multi-tenant: organization → locations |
| Payments | Fake `STRIPE_TX_<random>` token | Real Georgian gateway + payments table + webhook |
| Reminders | "Dispatch" button that marks *Sent* | Real SMS + email, scheduled |
| Sync/Backup | `localStorage` queue + fake status | The real cloud DB *is* the backup; drop the "offline engine" |
| AI | `@google/genai` scaffolded but unused | Not needed for MVP (optional later) |

**Reuse from the prototype:** the React components (`CalendarView`,
`PatientDatabase`, `RemindersSystem`, `CheckoutPayment`, `AnalyticsDashboard`)
port over almost unchanged — swap their `localStorage` reads/writes for API/DB
calls. Keep `types.ts` as the shared type contract.

---

## 2. Recommended stack

Chosen for solo/Claude-Code productivity, type-safety end to end, and a strong
multi-tenant + auth story out of the box.

- **Frontend:** keep React + Tailwind. Recommended to migrate the Vite SPA into
  **Next.js (App Router)** so front end and API live in one typed repo. (The
  existing components are plain React and move over directly.) *Alternative:*
  keep the Vite SPA and add a separate backend — more moving parts.
- **Database:** **PostgreSQL** (see `schema.sql`).
- **ORM / migrations:** **Prisma** (excellent with Claude Code) or Drizzle.
- **Backend / auth / tenancy:** **Supabase** is the pragmatic backbone —
  Postgres + Auth + **Row-Level Security** (real per-tenant isolation enforced
  at the DB) + realtime (for the notification feed) + storage (avatars) in one.
  *Alternative:* self-hosted Postgres + Auth.js/Clerk. Either is fine; do not
  build auth yourself.
- **Payments:** **BoG iPay** or **TBC E-Commerce** (Georgian gateways; Stripe
  does not support businesses registered in Georgia). Use the **Hosted Payment
  Page** so card data never touches your servers.
- **SMS:** a Georgian SMS provider; **Email:** a transactional email service.
- **Background jobs:** a scheduler/queue for sending reminders (e.g. cron +
  a jobs table, or a managed queue).
- **Hosting:** any Node host (Vercel, Cloud Run, Fly). Deploy the DB with the
  provider you chose above.

---

## 3. Multi-tenancy model

- `organization` = the paying account (e.g. "Grand Medical & Aurora Spa Group").
- `location` = one physical business, typed `clinic` or `salon`. An org can own
  several. **This is what the prototype's clinic/salon toggle becomes.**
- Every tenant-owned row carries `organization_id`. **Customers are org-scoped**
  (the prototype deliberately shares one customer across clinic & salon).
- Enforce isolation with **RLS** (policy sketch is in `schema.sql`) so no
  application bug can leak one tenant's patients to another.

---

## 4. Auth & RBAC

- Roles: `owner`, `practitioner`, `receptionist` (already in `types.ts`).
- A user's role lives in `memberships (organization_id, user_id, role)`.
- **Enforce on the server**, not by hiding tabs. Map the prototype's tab
  permissions to API-level checks:
  - `owner` → everything, incl. Business Intelligence.
  - `receptionist` → scheduler, customers, reminders, billing.
  - `practitioner` → scheduler, customers, sync.
- Keep the UI tab-filtering too (good UX), but it is **not** the security layer.

---

## 5. Data layer & booking integrity

- Full schema in `schema.sql`. Highlights:
  - `types.ts` interfaces map 1:1 to tables (`Patient`→`customers`,
    `Staff`→`staff`, `Appointment`→`appointments`).
  - `history: string[]` is normalized into `treatment_history` rows.
  - Staff availability strings become real `staff_availability` windows so the
    booker can validate against them.
- **Double-booking is prevented by the database** via a Postgres exclusion
  constraint on `(staff_id, time range)` for non-cancelled appointments — not by
  UI checks. This is the single most important correctness guarantee in a
  scheduler; do not skip it.

---

## 6. Module-by-module build plan

1. **Scheduler / Calendar** — server-side create/read/update of appointments,
   with availability validation and the anti-double-booking constraint. Booking
   modal (see prototype) posts to an API.
2. **Patients / Clients** — CRUD on `customers` + `treatment_history`. Sensitive
   fields (allergies, clinical notes) are encrypted and every access is audited.
3. **Reminders** — template editor persists to `message_templates`; a scheduled
   job renders `{PatientName}`/`{Date}`/… and sends real SMS/email X hours before
   an appointment, logging each to `message_log`.
4. **Billing & POS** — create a `payment`, redirect to the gateway hosted page,
   confirm via **webhook**, then update `appointments.payment_status`. Never
   trust the client for payment success — only the webhook.
5. **Business Intelligence** — the dashboard metrics (daily revenue, occupancy,
   staff roster) become real aggregate SQL queries, not hardcoded numbers.
6. **Sync & Backup** — **remove** as a feature. The cloud DB is the source of
   truth and the backup. If "on the go" access matters, ship a PWA (installable,
   responsive) — that covers it without a real offline engine.

---

## 7. Payments (Georgia specifics)

- **Gateway:** BoG iPay (largest market share, supports recurring billing) or
  TBC E-Commerce (clean REST API, recurring supported). UniPay aggregates both.
- **Integration:** Hosted Payment Page — user pays on the bank's secure page and
  returns. This keeps you out of heavy PCI-DSS audit scope.
- **Flow:** create `payment` (status `unpaid`) → redirect → gateway webhook →
  mark `paid` + set `appointments.payment_status = 'paid'`.
- Remove the prototype's cosmetic "PCI-Compliant SSL / Verified SSL SHA-256"
  footer text until the real thing is in place.

---

## 8. Security & compliance (this is a medical product)

Patient records here include health data (allergies, conditions, medications) —
**special-category data** under Georgia's personal data protection law, and full
GDPR if you serve EU clients. Bake in from day one:

- Encrypt sensitive columns at rest (see `customers` notes in `schema.sql`).
- **Audit log** every read/write of patient records (`audit_log` table).
- Capture explicit **consent** (`consent_at` / `consent_version`).
- Define a **data-retention** policy and honor deletion requests.
- Secrets in a secrets manager — never in the repo (the prototype ships a
  `.env.example`; keep real keys out of Git).
- TLS everywhere; least-privilege DB roles.

---

## 9. Recommended build order (phases)

**Phase 1 — MVP (make it real):**
1. Set up Postgres + run `schema.sql` (or generate Prisma models from it).
2. Auth + memberships + one seeded organization with two locations.
3. Scheduler + customers backed by the DB (replace all `localStorage`).
4. Anti-double-booking constraint verified with a test.

**Phase 2 — operations:**
5. Payments (one Georgian gateway, hosted page + webhook).
6. Reminders (real SMS/email + scheduler).
7. Business Intelligence on real aggregates.

**Phase 3 — polish & scale:**
8. Realtime notification feed, PWA, audit-log viewer, multi-location admin.
9. Optional AI features (e.g. natural-language booking) — only if they earn it.

---

## 10. How to drive this with Claude Code

- Put this file and `schema.sql` at the repo root; tell Claude Code to read both
  before starting.
- Work **one phase at a time**; commit and verify before moving on. Don't ask for
  "the whole app" in a single prompt.
- Start each task from the schema: "Generate Prisma models from `schema.sql`",
  then "Build the appointments API with the availability + double-booking rules",
  etc.
- Ask for a test on the double-booking constraint early — it's the correctness
  backbone of a scheduler.
