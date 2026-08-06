// k6 scenario — public-read paths under load.
//
// Hits /api/health + /book/<slug> repeatedly. Baseline traffic that any
// real deployment gets. Signed-in paths need a session cookie flow (see
// scheduler-signin.js in a later PR); this scenario stays anonymous so
// it also works against production without an org.
//
// Run:
//   BASE_URL=http://localhost:3000 k6 run k6/scheduler-read.js
//   BASE_URL=https://staging.bookpitch.ge PUBLIC_SLUG=demo k6 run k6/scheduler-read.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PUBLIC_SLUG = __ENV.PUBLIC_SLUG || '';

const healthLatency = new Trend('health_latency');
const bookPageLatency = new Trend('book_page_latency');

// 3 stages: ramp 20 vus in 30s, hold 60s, ramp down 30s.
// Total ~2 min, ~500 requests at steady state.
export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '60s', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% failed
    'http_req_duration{name:health}': ['p(95)<300'],
    'http_req_duration{name:book}': ['p(95)<1500'],
  },
};

export default function () {
  const h = http.get(`${BASE_URL}/api/health`, { tags: { name: 'health' } });
  healthLatency.add(h.timings.duration);
  check(h, {
    'health ok': (r) => r.status === 200,
    'health json ok=true': (r) => {
      try {
        return JSON.parse(r.body).ok === true;
      } catch {
        return false;
      }
    },
  });

  if (PUBLIC_SLUG) {
    const b = http.get(`${BASE_URL}/book/${PUBLIC_SLUG}`, { tags: { name: 'book' } });
    bookPageLatency.add(b.timings.duration);
    check(b, {
      'book 200': (r) => r.status === 200,
    });
  }

  sleep(1);
}
