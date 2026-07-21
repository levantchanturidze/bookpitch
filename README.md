# Bookpitch

Multi-tenant SaaS for clinic & salon scheduling. Turns the AI Studio prototype
(React 19 + Vite + Tailwind, `localStorage`-only) into a production Next.js +
Postgres + Supabase app. Source-of-truth documents at the repo root:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — build spec & stack
- [`schema.sql`](./schema.sql) — production PostgreSQL schema
- [`CLAUDE_CODE_PROMPTS.md`](./CLAUDE_CODE_PROMPTS.md) — phased build plan

## Project layout

```
app/            Next.js App Router routes (P1.3 wires the shell)
components/     Ported prototype components — not yet mounted
lib/            Shared code
  types.ts        Type contract (mirrors schema.sql; from prototype)
  seed-data.ts    Sample org / staff / customers (P1.1 seed source)
prisma/         Schema & migrations (added in P1.1)
prototype/      Reference: original React 19 + Vite prototype
public/         Static assets
```

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
npm run lint         # eslint
npx tsc --noEmit     # typecheck
npm run format       # prettier write
```

## Stack

Next.js 16 (App Router, TS) · Tailwind CSS 4 · React 19 · ESLint + Prettier.

Coming in later phases: Prisma + Postgres (P1.1) · Supabase Auth + RLS (P1.2) ·
BoG iPay / TBC E-Commerce (P2.1) · SMS + email reminders (P2.2).

## Build order

Work one prompt at a time from `CLAUDE_CODE_PROMPTS.md`. Commit and verify
before moving on — the golden rule is *never* "build the whole app in one step."
