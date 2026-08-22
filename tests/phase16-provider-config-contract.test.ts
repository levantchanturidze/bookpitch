import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SECURITY_ENV_VALIDATORS,
  invalidEnv,
  missingEnv,
  REQUIRED_EMAIL_ENV,
} from '@/lib/ops-metrics';

// -----------------------------------------------------------------------------
// F16-006. The config contract now sees a mocked provider.
//
// F16-001 and F16-002 made the resolvers refuse "mock" in production, but that
// only fires when something actually tries to pay or send — the first real
// payment, or the first reminder. The production monitor could still report a
// complete, valid configuration right up to that moment.
//
// invalidEnv() is the mechanism already built for "set but structurally
// unusable" (P15-010). A provider pinned to mock in production is exactly that,
// and so is a typo'd provider name, which the resolver would throw on too.
// -----------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs();
});

const PROVIDERS = [
  ['PAYMENT_GATEWAY', 'bog', ['bog', 'bog_ipay', 'tbc', 'tbc_ecommerce']],
  ['EMAIL_PROVIDER', 'resend', ['postmark', 'resend']],
  ['SMS_PROVIDER', 'smsoffice', ['smsoffice']],
] as const;

describe('F16-006 · a mocked provider is reported as invalid configuration', () => {
  for (const [variable, realExample, allReal] of PROVIDERS) {
    it(`${variable}: validator exists`, () => {
      expect(SECURITY_ENV_VALIDATORS[variable]).toBeTypeOf('function');
    });

    it(`${variable}: rejects "mock"`, () => {
      expect(SECURITY_ENV_VALIDATORS[variable]('mock')).toBe(false);
    });

    it(`${variable}: rejects case and whitespace variants of mock`, () => {
      expect(SECURITY_ENV_VALIDATORS[variable]('  MOCK ')).toBe(false);
    });

    it(`${variable}: rejects a typo'd provider name`, () => {
      expect(SECURITY_ENV_VALIDATORS[variable]('resnd')).toBe(false);
    });

    // Complement: every real adapter name must pass, or the contract would
    // report a correct production as broken.
    it(`${variable}: accepts every real adapter name`, () => {
      for (const name of allReal) {
        expect(SECURITY_ENV_VALIDATORS[variable](name), name).toBe(true);
      }
      expect(SECURITY_ENV_VALIDATORS[variable](realExample.toUpperCase())).toBe(true);
    });
  }

  it('invalidEnv() counts a mocked provider, and stops counting it once corrected', () => {
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    vi.stubEnv('EMAIL_PROVIDER', 'mock');
    vi.stubEnv('SMS_PROVIDER', 'mock');
    const flagged = invalidEnv();
    expect(flagged).toEqual(
      expect.arrayContaining(['PAYMENT_GATEWAY', 'EMAIL_PROVIDER', 'SMS_PROVIDER']),
    );

    vi.stubEnv('PAYMENT_GATEWAY', 'bog');
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('SMS_PROVIDER', 'smsoffice');
    const corrected = invalidEnv();
    for (const [variable] of PROVIDERS) expect(corrected).not.toContain(variable);
  });

  it('an unset provider is not double-reported by invalidEnv()', () => {
    // missingEnv() owns absence; invalidEnv() owns wrongness. Reporting both
    // for one variable would inflate the monitor's counts.
    vi.stubEnv('EMAIL_PROVIDER', '');
    expect(invalidEnv()).not.toContain('EMAIL_PROVIDER');
    expect(missingEnv(REQUIRED_EMAIL_ENV)).toContain('EMAIL_PROVIDER');
  });

  it('a synthetic provider id can never make the contract look healthy', () => {
    // The whole point: MockEmailProvider returns a providerMsgId that looks
    // exactly like a real one. The contract keys off configuration, not off
    // whatever the adapter returned.
    vi.stubEnv('EMAIL_PROVIDER', 'mock');
    expect(invalidEnv()).toContain('EMAIL_PROVIDER');
  });
});
