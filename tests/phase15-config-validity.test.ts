import { describe, it, expect } from 'vitest';
import { invalidEnv, SECURITY_ENV_VALIDATORS } from '@/lib/ops-metrics';
import { evaluateOpsMetrics, DEFAULTS } from '../scripts/production-monitor.mjs';

// -----------------------------------------------------------------------------
// P15-010 — presence is not validity.
//
// Production had FIELD_ENCRYPTION_KEY set, but without the "<key-id>:" prefix
// that lib/crypto.ts parseKeySpec() requires. Consequences, none of them
// visible:
//
//   • missingSecurityEnv was 0, so the monitor reported the configuration
//     complete and had done for weeks;
//   • every encryptField() call threw at the first byte, which means signup
//     (lib/onboarding.ts), patient allergies and clinical notes
//     (lib/customers.ts) and MFA enrolment (lib/platform/mfa.ts) were all
//     broken in production;
//   • nothing surfaced it because none of those paths had ever executed there.
//
// The first test below uses the exact shape of the real production value.
// -----------------------------------------------------------------------------

const VALID_KEY = `k1:${'a'.repeat(64)}`;
const VALID_HEX = 'b'.repeat(64);

describe('P15-010 FIELD_ENCRYPTION_KEY structural validation', () => {
  it('rejects a bare 64-hex key with no key-id prefix — the production value', () => {
    // This is the case that was live. If this ever passes, the check is gone.
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { FIELD_ENCRYPTION_KEY: 'a'.repeat(64) })).toEqual([
      'FIELD_ENCRYPTION_KEY',
    ]);
  });

  it('accepts a correctly prefixed key', () => {
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { FIELD_ENCRYPTION_KEY: VALID_KEY })).toEqual([]);
  });

  it('rejects a key whose hex half is the wrong length', () => {
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { FIELD_ENCRYPTION_KEY: 'k1:abcd' })).toEqual([
      'FIELD_ENCRYPTION_KEY',
    ]);
  });

  it('rejects a leading colon (empty key id)', () => {
    expect(
      invalidEnv(SECURITY_ENV_VALIDATORS, { FIELD_ENCRYPTION_KEY: `:${'a'.repeat(64)}` }),
    ).toEqual(['FIELD_ENCRYPTION_KEY']);
  });

  it('rejects non-hex characters in the key body', () => {
    expect(
      invalidEnv(SECURITY_ENV_VALIDATORS, { FIELD_ENCRYPTION_KEY: `k1:${'z'.repeat(64)}` }),
    ).toEqual(['FIELD_ENCRYPTION_KEY']);
  });

  it('agrees with the parser it is standing in for', () => {
    // The validator exists to predict whether lib/crypto.ts will throw. If the
    // two ever disagree, the monitor is lying about production.
    const cases = ['a'.repeat(64), 'k1:abcd', `:${'a'.repeat(64)}`, VALID_KEY];
    for (const spec of cases) {
      const validatorSaysOk = SECURITY_ENV_VALIDATORS.FIELD_ENCRYPTION_KEY(spec);
      let parserThrew = false;
      const colon = spec.indexOf(':');
      if (colon < 1) parserThrew = true;
      else parserThrew = Buffer.from(spec.slice(colon + 1), 'hex').length !== 32;
      expect(validatorSaysOk).toBe(!parserThrew);
    }
  });
});

describe('P15-010 other security secrets', () => {
  it('does not report an absent variable as invalid — that is missingEnv’s job', () => {
    // Double-reporting one problem as two makes the counts meaningless.
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, {})).toEqual([]);
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { FIELD_ENCRYPTION_KEY: '   ' })).toEqual([]);
  });

  it('validates the HMAC keys as bare 64-hex', () => {
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { RATE_LIMIT_HMAC_KEY: VALID_HEX })).toEqual([]);
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { EMAIL_PRIVACY_HMAC_KEY: 'nope' })).toEqual([
      'EMAIL_PRIVACY_HMAC_KEY',
    ]);
  });

  it('rejects a trivially short AUTH_SECRET', () => {
    expect(invalidEnv(SECURITY_ENV_VALIDATORS, { AUTH_SECRET: 'short' })).toEqual(['AUTH_SECRET']);
  });

  it('reports every malformed variable, not just the first', () => {
    expect(
      invalidEnv(SECURITY_ENV_VALIDATORS, {
        FIELD_ENCRYPTION_KEY: 'nope',
        AUTH_SECRET: 'short',
      }).sort(),
    ).toEqual(['AUTH_SECRET', 'FIELD_ENCRYPTION_KEY']);
  });
});

describe('P15-010 the monitor surfaces it', () => {
  const base = {
    outbox: { pending: 0, processing: 0, dead: 0, staleClaims: 0, oldestPendingAgeSeconds: null },
    housekeeping: { overdueRateLimitRows: 0, overdueExpiredTokens: 0, overdueReauthGrants: 0 },
    retention: { overdueCustomers: 0 },
    auditDigest: { hoursSinceLastQueued: 1, oldestEligibleOrgAgeHours: 10 },
    partitions: { monthsAhead: 3, defaultPartitionRows: 0 },
    config: {
      missingSignupEnv: 0,
      missingEmailEnv: 0,
      missingSecurityEnv: 0,
      invalidSecurityEnv: 0,
    },
  };

  it('passes when every secret parses', () => {
    const r = evaluateOpsMetrics(base, DEFAULTS);
    expect(r.find((c: { id: string }) => c.id === 'production-config-invalid')!.ok).toBe(true);
  });

  it('FAILS when a secret is set but malformed — the state production was in', () => {
    const r = evaluateOpsMetrics(
      { ...base, config: { ...base.config, invalidSecurityEnv: 1 } },
      DEFAULTS,
    );
    expect(r.find((c: { id: string }) => c.id === 'production-config-invalid')!.ok).toBe(false);
  });

  it('does not silently pass on a deployment that predates the metric', () => {
    // undefined must not be treated as zero without saying so, or the check
    // quietly reverts to the vacuous behaviour it was built to replace.
    const { invalidSecurityEnv: _drop, ...older } = base.config;
    const r = evaluateOpsMetrics({ ...base, config: older }, DEFAULTS);
    const check = r.find((c: { id: string }) => c.id === 'production-config-invalid')!;
    expect(check.detail).toMatch(/predates/i);
  });
});
