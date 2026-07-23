# k6 load tests

Two scenarios live here. Both take a `BASE_URL` env; a `PUBLIC_SLUG` is
required for anything that touches `/book/*`.

## Install

```
brew install k6
# or
docker run --rm -i grafana/k6 run - < k6/scheduler-read.js
```

## Read scenario — safe against any environment

```bash
BASE_URL=http://localhost:3000 k6 run k6/scheduler-read.js
BASE_URL=https://staging.bookpitch.ge PUBLIC_SLUG=demo k6 run k6/scheduler-read.js
```

Hits `/api/health` + optionally `/book/<slug>`. No writes. Baseline
thresholds:

- `< 1%` failed HTTP.
- p95 health latency `< 300 ms`.
- p95 book-page latency `< 1500 ms`.

## Write scenario — staging / throwaway only

```bash
BASE_URL=https://staging.bookpitch.ge \
  PUBLIC_SLUG=demo \
  STATIC_STAFF_ID=… STATIC_SERVICE_ID=… \
  k6 run k6/public-booking.js
```

Exercises the full public booking write path — GiST double-booking
guard, RLS, rate limiter, notifyEvent, audit_log tail. Will create
real appointments. **Never point at production.**

## In CI

`.github/workflows/load-test.yml` runs the read scenario every Sunday
04:00 UTC against `${{ secrets.STAGING_URL }}`. Set:

- `STAGING_URL` — https://staging.bookpitch.ge
- `STAGING_PUBLIC_SLUG` — optional, enables the book-page path

The job no-ops if `STAGING_URL` is unset so forks stay green.

## Interpreting output

k6 prints per-metric p95 / p99 on exit. The workflow uploads
`summary.json` as an artifact — feed it to your dashboarding tool of
choice, or diff week-over-week manually.
