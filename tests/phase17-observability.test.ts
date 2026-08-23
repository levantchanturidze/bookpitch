import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { collectConfigMetrics, REQUIRED_OBSERVABILITY_ENV } from '@/lib/ops-metrics';
import { evaluateOpsMetrics, DEFAULTS } from '../scripts/production-monitor.mjs';

// -----------------------------------------------------------------------------
// P17-007 — error reporting is configured, and its absence is observable.
//
// The Phase 16 audit found production with @sentry/nextjs installed, three
// config files present, instrumentation.ts exporting onRequestError,
// SENTRY_ENVIRONMENT and NEXT_PUBLIC_SENTRY_ENVIRONMENT both set — and no DSN.
// Every Sentry.init() in this repository sits behind `if (…_DSN)`, so the whole
// stack was a no-op. Nothing said so.
//
// That is the exact shape of P15-010: presence mistaken for function. The
// answer is the same one that worked there — turn it into a number the monitor
// watches, and test the number in both directions.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('an unconfigured Sentry is counted, not assumed', () => {
  it('both DSNs absent → 2 missing', () => {
    withEnv({ SENTRY_DSN: undefined, NEXT_PUBLIC_SENTRY_DSN: undefined }, () => {
      expect(collectConfigMetrics().missingObservabilityEnv).toBe(2);
    });
  });

  it('server DSN only → 1 missing, because the browser half is still blind', () => {
    withEnv(
      { SENTRY_DSN: 'https://k@example.invalid/1', NEXT_PUBLIC_SENTRY_DSN: undefined },
      () => {
        expect(collectConfigMetrics().missingObservabilityEnv).toBe(1);
      },
    );
  });

  it('both DSNs present → 0 missing', () => {
    withEnv(
      {
        SENTRY_DSN: 'https://k@example.invalid/1',
        NEXT_PUBLIC_SENTRY_DSN: 'https://k@example.invalid/2',
      },
      () => {
        expect(collectConfigMetrics().missingObservabilityEnv).toBe(0);
      },
    );
  });

  it('an empty string counts as absent — a blank var is not configuration', () => {
    withEnv({ SENTRY_DSN: '   ', NEXT_PUBLIC_SENTRY_DSN: '' }, () => {
      expect(collectConfigMetrics().missingObservabilityEnv).toBe(2);
    });
  });

  it('names the two variables it requires', () => {
    expect([...REQUIRED_OBSERVABILITY_ENV]).toEqual(['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN']);
  });
});

describe('the monitor reports blindness as its own incident', () => {
  const check = (metrics: unknown) =>
    (
      evaluateOpsMetrics(metrics, DEFAULTS) as Array<{ id: string; ok: boolean; detail: string }>
    ).find((r) => r.id === 'production-observability-unconfigured');

  const healthy = {
    outbox: { pending: 0, processing: 0, dead: 0, staleClaims: 0, oldestPendingAgeSeconds: null },
    housekeeping: { overdueRateLimitRows: 0, overdueExpiredTokens: 0, overdueReauthGrants: 0 },
    retention: { overdueCustomers: 0 },
    partitions: { monthsAhead: 3, defaultPartitionRows: 0 },
    config: {
      missingSignupEnv: 0,
      missingEmailEnv: 0,
      missingSecurityEnv: 0,
      invalidSecurityEnv: 0,
      missingObservabilityEnv: 0,
    },
  };

  it('passes when both DSNs are set', () => {
    expect(check(healthy)?.ok).toBe(true);
  });

  it('fails when a DSN is missing', () => {
    const blind = { ...healthy, config: { ...healthy.config, missingObservabilityEnv: 2 } };
    const result = check(blind);
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain('discarded');
  });

  it('is separate from production-config-incomplete, so blind is not read as down', () => {
    const blind = { ...healthy, config: { ...healthy.config, missingObservabilityEnv: 2 } };
    const all = evaluateOpsMetrics(blind, DEFAULTS) as Array<{ id: string; ok: boolean }>;
    // The app-is-broken check stays green; only the can-we-see-it check trips.
    expect(all.find((r) => r.id === 'production-config-incomplete')?.ok).toBe(true);
    expect(all.find((r) => r.id === 'production-observability-unconfigured')?.ok).toBe(false);
  });

  it('an older deployment without the metric says so instead of passing silently', () => {
    const old = { ...healthy, config: { ...healthy.config, missingObservabilityEnv: undefined } };
    expect(check(old)?.detail).toContain('predates');
  });
});

describe('browser errors are actually wired into the build', () => {
  // sentry.client.config.ts has existed since Phase 8 and never ran: the
  // @sentry/nextjs SDK finds that filename only from its own webpack config,
  // which runs only under `withSentryConfig`, which next.config.ts does not
  // use. Nothing imported it, so no bundle contained it.
  it('instrumentation-client.ts exists at the project root', () => {
    // Next.js only reads this convention from the root or from src/.
    expect(existsSync(path.join(ROOT, 'instrumentation-client.ts'))).toBe(true);
  });

  it('it pulls in the browser Sentry init', () => {
    const src = readFileSync(path.join(ROOT, 'instrumentation-client.ts'), 'utf-8');
    expect(src).toMatch(/import\(['"]\.\/sentry\.client\.config['"]\)/);
  });

  it('the import is guarded by the public DSN, so an unconfigured build ships nothing', () => {
    // Measured on this tree: a static import adds 63,243 bytes gzipped to the
    // shared client JS (458,764 with, 395,521 without) — for every visitor,
    // including the public booking widget, whether or not a DSN exists. With
    // the guard and no DSN the Sentry chunk is emitted but referenced from no
    // page entry graph in .next/build-manifest.json, so the browser never
    // fetches it. Turning this back into a top-level import would silently
    // put 61 KB back on every page load.
    const src = readFileSync(path.join(ROOT, 'instrumentation-client.ts'), 'utf-8');
    expect(src).toMatch(/if \(process\.env\.NEXT_PUBLIC_SENTRY_DSN\)/);
    // A bare top-level import would defeat the guard even if the guard remains.
    expect(src).not.toMatch(/^import ['"]\.\/sentry\.client\.config['"]/m);
  });

  it('the browser scrubber does not drag in a Node-only module', () => {
    // lib/logger.ts starts with `import { AsyncLocalStorage } from
    // 'node:async_hooks'`. Importing it from the client config is what made
    // `next build` fail with "the chunking context (unknown) does not support
    // external modules (request: node:async_hooks)" — which is the real reason
    // browser Sentry had never been wired up.
    const client = readFileSync(path.join(ROOT, 'sentry.client.config.ts'), 'utf-8');
    expect(client).not.toMatch(/from '@\/lib\/logger'/);
    expect(client).toMatch(/from '@\/lib\/scrub'/);

    // Match imports, not prose — the file explains this history in a comment.
    const scrub = readFileSync(path.join(ROOT, 'lib', 'scrub.ts'), 'utf-8');
    const imports = scrub.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports.filter((l) => l.includes('node:'))).toEqual([]);
    expect(imports).toEqual([]);
  });

  it('server and browser scrub with the same rules', () => {
    // One list of sensitive keys, not two that drift. lib/logger.ts re-exports
    // from lib/scrub.ts rather than keeping its own copy.
    const logger = readFileSync(path.join(ROOT, 'lib', 'logger.ts'), 'utf-8');
    expect(logger).toMatch(/from '\.\/scrub'/);
  });

  it('the client init is still gated on a public DSN, not a server one', () => {
    // A server DSN in the browser bundle would ship a credential to every
    // visitor. The guard and the dsn field must both use the NEXT_PUBLIC_ name.
    const src = readFileSync(path.join(ROOT, 'sentry.client.config.ts'), 'utf-8');
    expect(src).toContain('process.env.NEXT_PUBLIC_SENTRY_DSN');
    expect(src).not.toMatch(/dsn:\s*process\.env\.SENTRY_DSN/);
  });

  it('no config sends default PII — cookies, headers and IPs stay out', () => {
    for (const f of [
      'sentry.client.config.ts',
      'sentry.server.config.ts',
      'sentry.edge.config.ts',
    ]) {
      const src = readFileSync(path.join(ROOT, f), 'utf-8');
      expect(src, `${f} must set sendDefaultPii explicitly`).toContain('sendDefaultPii: false');
    }
  });

  it('every init is DSN-gated, which is why an absent DSN is silent', () => {
    // This is the fact that makes the monitor check necessary. If an init ever
    // stops being gated it would throw on boot instead, and this test should
    // be revisited rather than deleted.
    for (const f of [
      'sentry.client.config.ts',
      'sentry.server.config.ts',
      'sentry.edge.config.ts',
    ]) {
      const src = readFileSync(path.join(ROOT, f), 'utf-8');
      expect(src, `${f}`).toMatch(/if \(process\.env\.(NEXT_PUBLIC_)?SENTRY_DSN\)/);
    }
  });
});
