# Bookpitch

Multi-tenant SaaS for clinic & salon scheduling. Turns the AI Studio
prototype (React 19 + Vite + Tailwind, `localStorage`-only) into a
production Next.js + plain-Postgres + Auth.js app. Portable by design:
every piece except the payment gateway and SMS/email provider is
swappable.

Source-of-truth documents at the repo root:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — build spec & stack
- [`schema.sql`](./schema.sql) — production PostgreSQL schema
- [`CLAUDE_CODE_PROMPTS.md`](./CLAUDE_CODE_PROMPTS.md) — phased build plan

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| Database | Plain PostgreSQL — hosted free tier (Neon or Supabase) in an **EU region** |
| ORM | Prisma |
| Auth | Auth.js (NextAuth) with the Prisma adapter |
| Hosting | Vercel, region `fra1` (Frankfurt) |
| Payments | BoG iPay / TBC E-Commerce hosted payment page (mock adapter for dev) |
| SMS + email | Georgian SMS provider + a transactional email service (mock adapters for dev) |
| Avatars / files | Generated initials — no file uploads in MVP |
| Realtime | Polling every 30 s from the header bell (SSE deferred until earned) |

## Project layout

```
app/            Next.js App Router routes + API
components/     UI, split by module (patients/, scheduler/, billing/, …)
lib/            Server-only helpers (db, auth, audit, crypto, admin, gdpr, …)
prisma/         Schema + forward-only migrations + seed
public/         Static assets + service worker
scripts/        Ops scripts (backup, restore drill)
tests/          Vitest specs — run all with `npm run test`
prototype/      Reference: original React 19 + Vite prototype
```

## Getting started

Point the app at a hosted EU-region Postgres (Neon or Supabase — see
[`.env.example`](./.env.example) for URL shapes). Then:

```bash
cp .env.example .env.local          # fill DATABASE_URL, AUTH_SECRET, …
npm install
npm run db:migrate                  # applies every migration, forward-only
npm run db:seed                     # seeds 1 org, 2 locations, staff, services, 5 patients
npm run dev                         # http://localhost:3000
```

Dev users (from the seed): `owner@bookpitch.dev` / `reception@bookpitch.dev`,
password `devpass123`.

Other commands:
```bash
npm run test                        # vitest — 98/98
npm run lint                        # eslint 0 errors
npx tsc --noEmit                    # typecheck
npm run build && npm start          # prod build (SW registers only in prod)
```

## Throwaway local database

The hosted DB is the source of truth, but a Postgres container is
available for destructive migration experiments:

```bash
docker compose up -d
export DATABASE_URL="postgresql://bookpitch@localhost:5433/bookpitch_dev?schema=public"
npx prisma migrate deploy
npm run db:seed
```

Port `5433` (not `5432`) so it never clashes with a system-installed
Postgres.

## Deploy to Vercel (staging)

`vercel.json` pins the serverless region to `fra1`. In the Vercel project:

1. Import from the private GitHub repo.
2. Environment variables (Vercel dashboard — never in the repo):
   - `DATABASE_URL`, `DIRECT_URL`, `ADMIN_DATABASE_URL`
   - `AUTH_SECRET`, `AUTH_TRUST_HOST=true`
   - `FIELD_ENCRYPTION_KEY`
   - `PAYMENT_MOCK_SECRET`, `APP_URL=https://<your-project>.vercel.app`
   - `CRON_SECRET`
   - `SMS_PROVIDER=mock`, `EMAIL_PROVIDER=mock`, `ASSISTANT_MODEL=mock`
3. Health check: `GET /api/health` returns 200 + DB latency once the DB
   is reachable from `fra1`.

**Staging must contain no real patient data and no real payments.**
Vercel's free Hobby plan forbids commercial use — going live requires
Pro. Free-tier Neon/Supabase suspend on inactivity and have no
guaranteed backups — fine for staging, not fine for real patients.

## Build order

Work one prompt at a time from `CLAUDE_CODE_PROMPTS.md`. Commit and
verify before moving on — the golden rule is _never_ "build the whole
app in one step."
