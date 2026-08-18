# Performance and capacity baseline (Phase 15.8)

## How to reproduce

```bash
npm run build && npm run start          # or any disposable target
BASE_URL=http://localhost:3000 PERF_REQUESTS=120 PERF_CONCURRENCY=8 \
  node scripts/perf-baseline.mjs --json baseline.json
```

`scripts/perf-baseline.mjs` **refuses to run against production** — see §5.

## 1. Local baseline

Target `http://localhost:3000` (`next start`, production build), 120 requests
per scenario at concurrency 8, Node v24.16.0, Apple Silicon laptop, local
PostgreSQL. Warm — a preceding pass absorbed compilation and cold start.

| Scenario | Path | req | err | p50 ms | p95 ms | p99 ms | req/s |
|---|---|---|---|---|---|---|---|
| health | `/api/health` | 120 | 0 | 29.9 | 54.9 | 57.5 | 226.7 |
| signin | `/signin` | 120 | 0 | 148.9 | 1013.9 | 1015.3 | 37.9 |
| signup | `/signup` | 120 | 0 | 190.5 | 849.5 | 853.9 | 28.4 |
| privacy | `/privacy` | 120 | 0 | 226.4 | 659.0 | 1083.3 | 26.6 |
| terms | `/terms` | 120 | 0 | 192.3 | 853.8 | 870.4 | 28.8 |

Error rate 0% everywhere.

**Read these numbers for their shape, not their magnitude.** They come from one
laptop running the server, the database and the load generator simultaneously
at concurrency 8, so p95 is dominated by local contention. The useful signals
are: no errors under concurrency, no timeouts, and `/api/health` an order of
magnitude cheaper than a rendered page — which is what makes it a sound uptime
probe.

The first (cold) pass showed p95 of 3224 ms on `/signin` against 161 ms p50.
That is compilation and cold start, and it is worth knowing because production
is serverless and pays a comparable penalty on a cold invocation.

## 2. Production smoke probe

Low-volume only: 5 sequential requests per path, one second apart. This is a
smoke probe, not a load test, and no load test has been run against production.

| Path | Observed total time (s), 5 sequential |
|---|---|
| `/api/health` | 2.13, 0.35, 0.30, 0.29, 0.32 |
| `/signin` | 0.29, 0.26, 0.28, 0.32, 0.33 |
| `/signup` | 1.38, 0.35, 0.33, 0.80, 0.26 |

Warm production responses land at roughly **0.26–0.35 s** from this client,
including TLS and transatlantic round trips. The 2.13 s and 1.38 s first
samples are serverless cold starts — the dominant tail-latency factor in
production, and consistent with the local cold-start observation.

## 3. Constraints that set the envelope

| Layer | Constraint |
|---|---|
| Vercel (Hobby) | Serverless functions, region `fra1`; cold starts on idle; execution time and monthly invocation limits |
| Supabase Free | Shared instance, low connection ceiling, no PITR, ~24h backup RPO |
| Database access | `bookpitch_app` is `NOBYPASSRLS`; every tenant query carries an organisation filter and RLS |
| Scheduled work | GitHub Actions, not Vercel Cron — `*/15` reminders, hourly housekeeping, daily retention, weekly digest, monthly partitions |

The binding constraint for a pilot is **database connections**, not CPU. Each
serverless invocation can open a connection, so concurrency is limited by the
Supabase Free ceiling long before request latency becomes the problem.

## 4. Safe pilot envelope

Derived from the constraints above and the pilot caps in
`docs/pilot-plan-and-go-no-go.md`. Deliberately conservative.

| Dimension | Envelope |
|---|---|
| Organisations | 1–3 |
| Concurrent active users | ≤ 10 |
| Sustained request rate | ≤ 2 req/s |
| Short bursts | ≤ 10 req/s |
| Customer records | ≤ 500 |
| Appointments/day | ≤ 200 |
| Outbox messages/day | ≤ 200 |

**This is not a capacity claim.** Nothing here was measured at scale. The
envelope is what the architecture and free-tier limits make plausible for a
handful of clinics, and it is set low so that a wrong assumption is discovered
by a support conversation rather than an outage.

Explicitly **not** established: behaviour at hundreds of concurrent users,
connection-pool exhaustion, sustained multi-hour throughput, or memory ceilings
under load. Those need a disposable environment sized like production, which
does not exist.

## 5. Production guard (P15-007)

Before this phase, `.github/workflows/load-test.yml` gated only on
`STAGING_URL` being non-empty. If that secret were ever pointed at the
production URL, the weekly k6 run would have generated sustained load against
the live service with nothing to stop it.

Two guards now exist, and both fail closed:

- `scripts/perf-baseline.mjs` refuses any host matching `bookpitch.ge`,
  `vercel.app` or `supabase` — **even with `PERF_ALLOW_REMOTE` set** — and
  refuses any non-loopback host unless that override is supplied.
- The workflow refuses before k6 is installed or invoked, deriving the host
  from the secret without ever echoing the URL.

`vercel.app` is included because a Preview deployment inherits production
environment variables unless overridden, so load against a preview URL can
reach the production database.

Covered by `tests/phase15-perf-guard.test.ts`, including the case that matters
most: production is refused *with* the override set. Note the guard also
refuses `staging.bookpitch.ge`. That is deliberate over-strictness — if staging
ever lives on a `bookpitch.ge` subdomain, add the exception knowingly rather
than loosening the marker list.

## 6. Not covered

Authenticated read paths (patient listing, scheduler retrieval, dashboards) and
appointment creation are **not** in the baseline. They need a seeded, logged-in
session; the current script is unauthenticated by design so it can never
consume a rate-limit budget or write. Extending it to a seeded disposable
database is the obvious next step and is not done here.

Rate-limited endpoints were deliberately not probed. Driving them to their
limit to measure the limit would either pollute the rate-limit tables or
require raising the limit — and lowering a security control to obtain a nicer
number is not a measurement worth having.
