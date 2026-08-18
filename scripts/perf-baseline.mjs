#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Deterministic performance baseline (Phase 15.8).
//
// Measures latency distribution, error rate and throughput for a set of
// launch-critical HTTP reads. Intended for a local, CI or disposable target.
//
// PRODUCTION GUARD (P15-007). This refuses to run against a production
// hostname. The guard is an ALLOW-list of loopback-ish hosts plus a deny-list
// of known production hostnames, and it fails closed: an unrecognised remote
// host is refused, not permitted. Overriding requires
// PERF_ALLOW_REMOTE=i-understand-this-generates-load, which is deliberately
// awkward to type by accident and impossible to set by mistake in a workflow.
//
// Why a guard at all: `.github/workflows/load-test.yml` gates only on whether
// STAGING_URL is non-empty. If that secret were ever pointed at production,
// the weekly job would generate sustained load against the live service with
// nothing to stop it.
//
// Usage:
//   node scripts/perf-baseline.mjs                       # localhost:3000
//   BASE_URL=http://localhost:3210 node scripts/perf-baseline.mjs
//   node scripts/perf-baseline.mjs --json out.json
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const REQUESTS = Number(process.env.PERF_REQUESTS ?? 60);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 6);
const OVERRIDE = 'i-understand-this-generates-load';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PRODUCTION_MARKERS = ['bookpitch.ge', 'vercel.app', 'supabase'];

/** Exported for tests: decide whether a target may be load-tested. */
export function assertSafeTarget(rawUrl, { allowRemote = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`BASE_URL is not a valid URL`);
  }
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which would
  // otherwise never match the loopback allow-list and refuse a local target.
  const host = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');

  for (const marker of PRODUCTION_MARKERS) {
    if (host === marker || host.endsWith(`.${marker}`) || host.includes(marker)) {
      throw new Error(
        `refusing to generate load against ${host} — it matches production marker "${marker}"`,
      );
    }
  }

  if (LOOPBACK.has(host)) return { host, kind: 'loopback' };

  if (!allowRemote) {
    throw new Error(
      `refusing to generate load against non-loopback host ${host}. ` +
        `Set PERF_ALLOW_REMOTE=${OVERRIDE} if this is a disposable environment you control.`,
    );
  }
  return { host, kind: 'remote-explicitly-allowed' };
}

/** Launch-critical public reads. No writes, no credentials, no rate-limit abuse. */
const SCENARIOS = [
  { name: 'health', path: '/api/health' },
  { name: 'signin', path: '/signin' },
  { name: 'signup', path: '/signup' },
  { name: 'privacy', path: '/privacy' },
  { name: 'terms', path: '/terms' },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function measure(path) {
  const durations = [];
  let errors = 0;
  const started = performance.now();

  let issued = 0;
  async function worker() {
    while (issued < REQUESTS) {
      issued += 1;
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE_URL}${path}`, { redirect: 'manual' });
        // 2xx and 3xx are both valid outcomes for these paths.
        if (res.status >= 400) errors += 1;
        await res.arrayBuffer();
      } catch {
        errors += 1;
      }
      durations.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wall = (performance.now() - started) / 1000;
  const sorted = durations.slice().sort((a, b) => a - b);

  return {
    requests: durations.length,
    errors,
    errorRate: durations.length ? errors / durations.length : 0,
    throughputPerSec: wall > 0 ? durations.length / wall : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? null,
  };
}

async function main() {
  const allowRemote = process.env.PERF_ALLOW_REMOTE === OVERRIDE;
  let target;
  try {
    target = assertSafeTarget(BASE_URL, { allowRemote });
  } catch (err) {
    console.error(`perf-baseline: ${err.message}`);
    process.exit(2);
  }

  console.log(`target      : ${BASE_URL} (${target.kind})`);
  console.log(`requests    : ${REQUESTS} per scenario, concurrency ${CONCURRENCY}`);
  console.log(`node        : ${process.version}`);
  console.log('');
  console.log('scenario        req  err   p50ms   p95ms   p99ms   req/s');

  const results = {};
  for (const s of SCENARIOS) {
    const r = await measure(s.path);
    results[s.name] = { path: s.path, ...r };
    const f = (v) => (v === null ? '   -  ' : v.toFixed(1).padStart(6));
    console.log(
      `${s.name.padEnd(14)}${String(r.requests).padStart(5)}${String(r.errors).padStart(5)}` +
        `${f(r.p50)}  ${f(r.p95)}  ${f(r.p99)}  ${r.throughputPerSec.toFixed(1).padStart(6)}`,
    );
  }

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(
      process.argv[jsonIdx + 1],
      JSON.stringify({ target: BASE_URL, at: new Date().toISOString(), results }, null, 2),
    );
  }

  const worstError = Math.max(...Object.values(results).map((r) => r.errorRate));
  if (worstError > 0.01) {
    console.error(`\nerror rate ${(worstError * 100).toFixed(1)}% exceeds 1%`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
