import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEmailProvider, getSmsProvider } from '@/lib/messaging';
import { MockEmailProvider } from '@/lib/messaging/email/mock';
import { MockSmsProvider } from '@/lib/messaging/sms/mock';
import { ResendEmailProvider } from '@/lib/messaging/email/resend';

// -----------------------------------------------------------------------------
// F16-002. Same shape as F16-001, different subsystem.
//
// getSmsProvider() and getEmailProvider() resolved `<VAR> ?? 'mock'`. The mock
// adapters return a providerMsgId without contacting anyone, so an unset
// variable in production would not raise — it would mark every verification
// email and every reminder as delivered while sending nothing. The outbox row
// reaches 'sent' and message_log gets an id, so every downstream health signal
// stays green.
//
// EMAIL_PROVIDER is in REQUIRED_EMAIL_ENV, so its absence is counted by the
// monitor; SMS_PROVIDER is not counted anywhere. Neither check stopped the code
// from falling back, which is the point: a count is not a control.
// -----------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('F16-002 · messaging providers fail closed in production', () => {
  for (const [variable, resolve] of [
    ['EMAIL_PROVIDER', getEmailProvider],
    ['SMS_PROVIDER', getSmsProvider],
  ] as const) {
    it(`${variable}: throws when unset in production`, () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(variable, '');
      expect(() => resolve()).toThrow(/must be set in production/i);
    });

    it(`${variable}: throws when explicitly mock in production`, () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(variable, 'mock');
      expect(() => resolve()).toThrow(/not permitted in production/i);
    });

    it(`${variable}: treats whitespace as unset`, () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(variable, '  ');
      expect(() => resolve()).toThrow(/must be set in production/i);
    });

    it(`${variable}: rejects an unknown provider name`, () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(variable, 'carrier-pigeon');
      expect(() => resolve()).toThrow(new RegExp(`Unknown ${variable}`, 'i'));
    });
  }

  // Complement: development must keep working exactly as before, otherwise the
  // fix has just moved the breakage.
  it('still falls back to the mock email provider outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('EMAIL_PROVIDER', '');
    expect(getEmailProvider()).toBeInstanceOf(MockEmailProvider);
  });

  it('still falls back to the mock sms provider outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SMS_PROVIDER', '');
    expect(getSmsProvider()).toBeInstanceOf(MockSmsProvider);
  });

  it('still honours an explicit mock outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('EMAIL_PROVIDER', 'mock');
    expect(getEmailProvider()).toBeInstanceOf(MockEmailProvider);
  });

  // A real provider in production is the case that must keep working.
  it('resolves a real email provider in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    expect(getEmailProvider()).toBeInstanceOf(ResendEmailProvider);
  });
});
