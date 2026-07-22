# Clinic & Salon Schedule Manager — Production Architecture & Build Spec

**Purpose:** promote the AI Studio prototype into a real, multi-tenant SaaS.
This document is written to be handed directly to **Claude Code** as a build
brief. Pair it with `schema.sql` (database schema) and
`CLAUDE_CODE_PROMPTS.md` (task-by-task build plan).

**Guiding constraint for this build: start at zero cost, and stay portable.**
No component may be one we cannot swap out later. Concretely: the database is
plain PostgreSQL (any provider), and authentication is a library running in our
own code — not a vendor service. The only genuinely external dependencies are
the payment gateway and the SMS/email provider, which are unavoidable.

---

## 1. What exists today (prototype reality)

The prototype is a **React 19 + Vite + Tailwind single-page app**. The UI and the
data model (`src/types.ts`) are solid and worth keeping. Everything behind the UI
is simulated:

| Area | Prototype today | Needs to become |
|---|---|---|
| Data store | Browser `localStorage` | Real PostgreSQL database |
| Auth | A role dropdown ("Owner (Unrestricted)") | Auth.js login + server-enforced RBAC |
| Tenancy | One implicit business, clinic/salon toggle | Multi-tenant: organization → locations |
| Payments | Fake `STRIPE_TX_<random>` token | Georgian gateway + payments table + webhook |
| Reminders | "Dispatch" button that marks *Sent* | Real SMS + email, scheduled |
| Sync/Backup | `localStorage` queue + fake status | Drop it — the database is the source of truth |
| AI | `@google/genai` scaffolded but unused | Not needed for MVP (optional later) |

**Reuse from the prototype:** the React components (`CalendarView`,
`PatientDatabase`, `RemindersSystem`, `CheckoutPayment`, `AnalyticsDashboard`)
port over almost unchanged — swap their `localStorage` reads/writes for API
calls. Keep `types.ts` as the shared type contract, and `data.ts` as the seed
source.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router, TypeScript)** | Frontend + API in one typed repo; prototype components move over directly |
| Database | **PostgreSQL** — hosted free tier (Neon or Supabase), **EU region** | Plain Postgres; provider swappable via `DATABASE_URL` |
| ORM | **Prisma** | Works well with Claude Code; migrations included |
| Auth | **Auth.js** (or Better Auth) with the Prisma adapter | Runs in our code, on our database — no vendor lock-in |
| Hosting | **Vercel** (region `fra1`) | `git push` → deploy; Hobby for staging, Pro when commercial |
| Payments | **BoG iPay** or **TBC E-Commerce**, hosted payment page | Stripe does not serve Georgia-registered businesses |
| SMS / Email | Georgian SMS provider + a transactional email service | Unavoidable external services |
| Avatars / files | Skip for MVP (generated initials); later Cloudflare R2 or Vercel Blob | Serverless has no persistent disk |
| Realtime | Polling for MVP → Server-Sent Events later | Avoids a realtime vendor entirely |

**Version control from day one:** a **private GitHub repo**. The project must
never live only on one laptop.

**Local development:** point `DATABASE_URL` at the hosted free database. Docker
Postgres stays available for throwaway experiments (destructive migration tests),
but it is **not** the source of truth.

---

## 3. Multi-tenancy model

- `organization` = the paying account (e.g. "Grand Medical & Aurora Spa Group").
- `location` = one physical business, typed `clinic` or `salon`. An org can own
  several. **This is what the prototype's clinic/salon toggle becomes.**
- Every tenant-owned row carries `organization_id`. **Customers are org-scoped**
  (the prototype deliberately shares one customer across clinic & salon).

### Tenant isolation — two layers

Because we use our own auth rather than a platform that injects JWT claims into
Postgres, isolation is enforced as follows:

1. **Application layer (mandatory).** All database access goes through a scoped
   data-access layer that *requires* an `organizationId` derived from the server
   session. Route handlers must never call Prisma directly with an org id taken
   from the request body or query string.
2. **Row-Level Security (recommended, defence in depth).** Open a transaction,
   `SET LOCAL app.current_org_id = '<uuid>'`, and let RLS policies read it via
   `current_setting('app.current_org_id', true)::uuid`. Two requirements: the
   application must connect as a **non-owner role**, and tables should use
   `FORCE ROW LEVEL SECURITY` — a table's owner bypasses RLS otherwise.

Layer 1 is required. Layer 2 means an application bug alone cannot leak one
clinic's patients to another.

---

## 4. Auth & RBAC

- Roles: `owner`, `practitioner`, `receptionist` (already in `types.ts`).
- A user's role lives in `memberships (organization_id, user_id, role)`.
- **Auth.js** handles credentials, sessions, password hashing and reset flows.
  Do not hand-roll authentication.
- **Enforce roles on the server**, not by hiding tabs:
  - `owner` → everything, incl. Business Intelligence.
  - `receptionist` → scheduler, customers, reminders, billing.
  - `practitioner` → scheduler, customers.
- Keep the UI tab-filtering too (good UX), but it is **not** the security layer.

---

## 5. Data layer & booking integrity

- Full schema in `schema.sql`. Highlights:
  - `types.ts` interfaces map 1:1 to tables (`Patient`→`customers`,
    `Staff`→`staff`, `Appointment`→`appointments`).
  - `history: string[]` is normalized into `treatment_history` rows.
  - Staff availability strings become real `staff_availability` windows.
- **Double-booking is prevented by the database** via a Postgres exclusion
  constraint on `(staff_id, time range)` for non-cancelled appointments — not by
  UI checks. This is the single most important correctness guarantee in a
  scheduler; do not skip it.

---

## 6. Module-by-module build plan

1. **Scheduler / Calendar** — server-side appointment CRUD, availability
   validation, DB-enforced anti-double-booking.
2. **Patients / Clients** — CRUD on `customers` + `treatment_history`. Sensitive
   fields encrypted; every access audited.
3. **Reminders** — templates in `message_templates`; a scheduled job renders
   `{PatientName}`/`{Date}`/… and sends real SMS/email, logged to `message_log`.
4. **Billing & POS** — create a `payment`, redirect to the gateway's hosted page,
   confirm via **webhook**, then update `appointments.payment_status`.
5. **Business Intelligence** — dashboard metrics become real aggregate SQL.
6. **Sync & Backup** — **removed** as a feature. Ship a PWA instead for "on the
   go" access.

---

## 7. Payments (Georgia specifics)

- **Gateway:** BoG iPay (largest market share, supports recurring billing) or
  TBC E-Commerce (clean REST API, recurring supported). UniPay aggregates both.
- **Integration:** Hosted Payment Page — the customer pays on the bank's secure
  page and returns. This keeps you out of heavy PCI-DSS audit scope.
- **Flow:** create `payment` (status `unpaid`) → redirect → gateway webhook →
  mark `paid` + set `appointments.payment_status = 'paid'`. The webhook is the
  only source of truth for success; never the client redirect.
- Remove the prototype's cosmetic "PCI-Compliant SSL / Verified SSL SHA-256"
  footer text until the real thing is in place.

---

## 8. Security, privacy & data residency

Patient records here include health data (allergies, conditions, medications) —
**special-category data** under Georgia's personal data protection law, and full
GDPR if you serve EU clients. Under Georgian law, transferring data abroad
requires that the receiving country provides adequate safeguards — which is why
the hosting region is a compliance decision, not a technical one.

Requirements from day one:

- **EU region** (Frankfurt) for the database, the app, **and its backups**.
  A database in the EU with backups elsewhere defeats the purpose.
- Encrypt sensitive columns at rest (see `customers` in `schema.sql`).
- **Audit log** every read/write of patient records (`audit_log` table).
- Capture explicit **consent** (`consent_at` / `consent_version`).
- Application logs must never contain patient names, contacts or clinical fields.
- Secrets in environment variables / a secrets manager — never in Git.
- Sign a **DPA** with each processor (hosting, database, SMS, email).
- Define a data-retention policy and honour deletion requests.

> Not legal advice. Have a data-protection lawyer review this before processing
> real patient data.

---

## 9. Cost path (start at zero)

| Stage | Setup | Cost |
|---|---|---|
| Development | GitHub private repo + hosted free Postgres (EU) | **$0** |
| Demo / staging | Vercel Hobby + free Postgres, no real patients or payments | **$0** |
| Going live | Vercel Pro + paid Postgres tier | ~$25–45/mo |

**Why the free tiers cannot serve real clinics:** free Postgres tiers have no
automated backups and suspend on inactivity or quota exhaustion. Vercel's Hobby
plan additionally forbids commercial use — processing payments on it is a terms
violation. Both are fine for building and demoing; neither is fine for live
patient data.

**Migration when revenue arrives** is deliberately cheap: the database moves with
`pg_dump` / `pg_restore` and one changed `DATABASE_URL`, and because auth lives
in our own tables via Auth.js, no user accounts need migrating.

---

## 10. Recommended build order

**Phase 1 — MVP (make it real):** hosted DB + schema → Auth.js + memberships +
tenant isolation → port the UI → customers module → scheduler with DB-enforced
anti-double-booking → deploy to staging.

**Phase 2 — operations:** payments (one Georgian gateway) → reminders (real
SMS/email) → BI on real aggregates.

**Phase 3 — polish & scale:** notification feed → PWA → compliance tooling →
multi-location admin → optional AI booking assistant.

---

## 11. How to drive this with Claude Code

- Keep this file, `schema.sql` and `CLAUDE_CODE_PROMPTS.md` at the repo root and
  tell Claude Code to read all three before starting.
- Work **one task at a time**; commit and verify before moving on. Never ask for
  "the whole app" in a single prompt.
- Ask for a test on the double-booking constraint early — it is the correctness
  backbone of a scheduler.
