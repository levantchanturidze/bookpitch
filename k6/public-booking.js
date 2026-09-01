// k6 scenario — full public booking write path.
//
// Simulates customers hitting POST /api/public/book. Exercises the
// rate limiter (T4-B5), GiST exclusion constraint, RLS-scoped INSERTs,
// and the notifyEvent + audit_log tail. If this scenario passes cleanly
// the write path is production-ready under bursty traffic.
//
// A PUBLIC_SLUG env is REQUIRED — a real location with public_slug set
// and at least one staff + one service.
//
// Note: this test WILL create real appointments in the target DB. Run
// only against staging or a throwaway org.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PUBLIC_SLUG = __ENV.PUBLIC_SLUG;
if (!PUBLIC_SLUG) throw new Error('PUBLIC_SLUG env is required');

// Sample staff + service ids from the widget's initial GET so writes
// have valid FKs. Cached per-VU via the setup hook.
export function setup() {
  const res = http.get(`${BASE_URL}/api/public/widget-info?slug=${PUBLIC_SLUG}`, {
    tags: { name: 'widget-info' },
  });
  // The widget-info endpoint is optional — if it isn't wired, fall
  // back to STATIC_STAFF_ID + STATIC_SERVICE_ID env vars.
  if (res.status === 200) {
    try {
      const j = JSON.parse(res.body);
      return { staffId: j.staff[0].id, serviceId: j.services[0].id };
    } catch {
      /* fall through */
    }
  }
  const staffId = __ENV.STATIC_STAFF_ID;
  const serviceId = __ENV.STATIC_SERVICE_ID;
  if (!staffId || !serviceId) {
    throw new Error(
      'Could not derive staffId/serviceId — set STATIC_STAFF_ID + STATIC_SERVICE_ID env vars',
    );
  }
  return { staffId, serviceId };
}

const bookLatency = new Trend('book_latency');
const rateLimited = new Counter('rate_limited_429');
const slotTaken = new Counter('slot_taken_409');

export const options = {
  stages: [
    { duration: '20s', target: 5 },
    { duration: '40s', target: 10 },
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'], // some 409s are expected (slot races)
    'http_req_duration{name:book}': ['p(95)<2000'],
  },
};

function randomFutureIso() {
  // 1-30 days ahead, in half-hour steps.
  const daysAhead = 1 + Math.floor(Math.random() * 30);
  const hour = 9 + Math.floor(Math.random() * 8);
  const minute = Math.random() < 0.5 ? 0 : 30;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export default function publicBookingScenario(data) {
  const body = {
    slug: PUBLIC_SLUG,
    staffId: data.staffId,
    serviceId: data.serviceId,
    startsAt: randomFutureIso(),
    customerName: `Load Test ${__VU}-${__ITER}`,
    customerEmail: `load-${__VU}-${__ITER}-${Date.now()}@example.dev`,
    consented: true,
  };
  const res = http.post(`${BASE_URL}/api/public/book`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'book' },
  });
  bookLatency.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  if (res.status === 409) slotTaken.add(1);
  check(res, {
    'book 2xx or expected 4xx': (r) => r.status === 201 || r.status === 429 || r.status === 409,
  });
  sleep(1);
}
