import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PROVIDER_CONTRACT,
  providerState,
  requiredProviderCredentials,
  providerRequiredEnv,
  collectConfigMetrics,
  missingEnv,
} from '@/lib/ops-metrics';

// -----------------------------------------------------------------------------
// §4.5 — the outbound-provider configuration contract.
//
// Three ways production could be misconfigured and report itself healthy, all
// of them live before this contract existed:
//
//   1. PAYMENT_GATEWAY and SMS_PROVIDER were in NO required-variable set.
//      Unsetting either left missingSignupEnv / missingEmailEnv /
//      missingSecurityEnv all at 0 and the monitor called the configuration
//      complete — while getGateway() and getSmsProvider() throw in production
//      on an unset variable ("refusing to default to the mock provider"). The
//      feature was dead and the only report was a 500 nobody would read.
//
//   2. The email requirement list was hard-coded to Resend. getEmailProvider()
//      accepts `postmark` and then reads POSTMARK_API_TOKEN and POSTMARK_FROM,
//      neither of which was checked, while two Resend variables that nothing
//      would read were reported as missing. The check disagreed with the
//      resolver, and the resolver is the one that runs.
//
//   3. `mock` was accepted as a deliberate pre-launch state for ANY provider,
//      inferred from the value of the variable alone. A mocked EMAIL provider
//      means nobody can complete signup, reset a password, or receive an audit
//      digest — and it would have been reported as a deliberate pause, in
//      grey, forever.
//
// Every case below is tested in both directions: a configuration that must
// fail, and the neighbouring one that must pass.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

/** A production-shaped environment, overridable per case. */
function env(overrides: Record<string, string | undefined> = {}) {
  return {
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'test',
    RESEND_FROM: 'noreply@example.test',
    SMS_PROVIDER: 'mock',
    PAYMENT_GATEWAY: 'mock',
    ...overrides,
  };
}

describe('provider state is distinguished four ways', () => {
  it('missing', () => {
    expect(providerState('SMS_PROVIDER', env({ SMS_PROVIDER: undefined }))).toBe('missing');
    expect(providerState('SMS_PROVIDER', env({ SMS_PROVIDER: '   ' }))).toBe('missing');
  });

  it('mock', () => {
    expect(providerState('SMS_PROVIDER', env({ SMS_PROVIDER: 'mock' }))).toBe('mock');
    expect(providerState('SMS_PROVIDER', env({ SMS_PROVIDER: 'MOCK' }))).toBe('mock');
  });

  it('real', () => {
    expect(providerState('EMAIL_PROVIDER', env({ EMAIL_PROVIDER: 'resend' }))).toBe('real');
    expect(providerState('EMAIL_PROVIDER', env({ EMAIL_PROVIDER: 'postmark' }))).toBe('real');
    expect(providerState('PAYMENT_GATEWAY', env({ PAYMENT_GATEWAY: 'tbc_ecommerce' }))).toBe(
      'real',
    );
  });

  it('unrecognised — a typo is not a deferral', () => {
    // `mokc` fails closed at the first send and nowhere earlier, which is
    // exactly as broken as `mock` and considerably more surprising.
    expect(providerState('SMS_PROVIDER', env({ SMS_PROVIDER: 'mokc' }))).toBe('unrecognised');
    expect(providerState('EMAIL_PROVIDER', env({ EMAIL_PROVIDER: 'sendgrid' }))).toBe(
      'unrecognised',
    );
  });
});

describe('credentials are resolved against the SELECTED adapter', () => {
  it('Resend asks for Resend variables', () => {
    expect(
      requiredProviderCredentials('EMAIL_PROVIDER', env({ EMAIL_PROVIDER: 'resend' })),
    ).toEqual(['RESEND_API_KEY', 'RESEND_FROM']);
  });

  it('Postmark asks for Postmark variables, and NOT for Resend ones', () => {
    const needed = requiredProviderCredentials(
      'EMAIL_PROVIDER',
      env({ EMAIL_PROVIDER: 'postmark' }),
    );
    expect(needed).toEqual(['POSTMARK_API_TOKEN', 'POSTMARK_FROM']);
    expect(needed).not.toContain('RESEND_API_KEY');
  });

  it('each payment adapter asks for its own credentials', () => {
    expect(requiredProviderCredentials('PAYMENT_GATEWAY', env({ PAYMENT_GATEWAY: 'bog' }))).toEqual(
      ['BOG_CLIENT_ID', 'BOG_CLIENT_SECRET', 'BOG_WEBHOOK_PUBLIC_KEY'],
    );
    expect(requiredProviderCredentials('PAYMENT_GATEWAY', env({ PAYMENT_GATEWAY: 'tbc' }))).toEqual(
      ['TBC_API_KEY', 'TBC_CLIENT_ID', 'TBC_CLIENT_SECRET', 'TBC_WEBHOOK_SECRET'],
    );
  });

  it('a missing or mocked provider demands no credentials', () => {
    // Demanding Resend's keys from a deployment that has not chosen an email
    // provider would report the wrong problem.
    expect(requiredProviderCredentials('SMS_PROVIDER', env({ SMS_PROVIDER: 'mock' }))).toEqual([]);
    expect(requiredProviderCredentials('SMS_PROVIDER', env({ SMS_PROVIDER: undefined }))).toEqual(
      [],
    );
  });

  it('the contract matches the credentials each adapter actually reads', () => {
    // Reads the provider modules and asserts every requireEnv() name is in the
    // contract. Without this the contract is a second, drifting copy of the
    // truth — which is precisely how the Resend-only list survived Postmark
    // being added.
    const sources: Record<string, string[]> = {
      'EMAIL_PROVIDER.resend': ['lib/messaging/email/resend.ts'],
      'EMAIL_PROVIDER.postmark': ['lib/messaging/email/postmark.ts'],
      'SMS_PROVIDER.smsoffice': ['lib/messaging/sms/smsoffice.ts'],
      'PAYMENT_GATEWAY.bog': ['lib/payments/gateways/bog.ts'],
      'PAYMENT_GATEWAY.tbc': ['lib/payments/gateways/tbc.ts'],
    };
    for (const [key, files] of Object.entries(sources)) {
      const [variable, adapter] = key.split('.');
      const declared = new Set(PROVIDER_CONTRACT[variable].adapters[adapter]);
      const read = new Set<string>();
      for (const f of files) {
        const src = readFileSync(path.join(ROOT, f), 'utf8');
        for (const m of src.matchAll(/requireEnv\('([A-Z0-9_]+)'\)/g)) read.add(m[1]);
      }
      for (const name of read) {
        expect(declared, `${key}: ${name} is read but not declared in PROVIDER_CONTRACT`).toContain(
          name,
        );
      }
      expect(read.size, `${key}: no requireEnv() calls found — did the file move?`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('config metrics report each state as the right kind of problem', () => {
  it('a fully-configured production reports no faults', () => {
    const m = collectConfigMetrics(
      env({ SMS_PROVIDER: 'smsoffice', SMSOFFICE_API_KEY: 'k', SMSOFFICE_SENDER: 's' }),
    );
    expect(m.missingProviderEnv).toBe(0);
    expect(m.missingProviderCredentialEnv).toBe(0);
    expect(m.unrecognisedProviderEnv).toBe(0);
    expect(m.undeclaredMockProviderEnv).toBe(0);
    expect(m.missingEmailEnv).toBe(0);
  });

  it('THE REGRESSION: an unset PAYMENT_GATEWAY is no longer invisible', () => {
    const m = collectConfigMetrics(env({ PAYMENT_GATEWAY: undefined }));
    expect(m.missingProviderEnv).toBe(1);
    // …and it must not be miscounted as any of the other states.
    expect(m.mockedProviderEnv).toBe(1); // SMS only
    expect(m.unrecognisedProviderEnv).toBe(0);
  });

  it('THE REGRESSION: an unset SMS_PROVIDER is no longer invisible', () => {
    const m = collectConfigMetrics(env({ SMS_PROVIDER: undefined }));
    expect(m.missingProviderEnv).toBe(1);
  });

  it('Postmark selected without its token is counted', () => {
    const m = collectConfigMetrics(
      env({ EMAIL_PROVIDER: 'postmark', RESEND_API_KEY: undefined, RESEND_FROM: undefined }),
    );
    expect(m.missingProviderCredentialEnv).toBe(2);
    // The old list would have reported the two absent RESEND_* variables and
    // said nothing about Postmark. Now the Resend variables are irrelevant.
    expect(m.missingEmailEnv).toBe(2);
  });

  it('Postmark selected WITH its token is clean, even with no Resend keys', () => {
    const m = collectConfigMetrics(
      env({
        EMAIL_PROVIDER: 'postmark',
        POSTMARK_API_TOKEN: 't',
        POSTMARK_FROM: 'a@b.test',
        RESEND_API_KEY: undefined,
        RESEND_FROM: undefined,
      }),
    );
    expect(m.missingProviderCredentialEnv).toBe(0);
    expect(m.missingEmailEnv).toBe(0);
  });

  it('a typo is a fault, and is not counted as a deferral', () => {
    const m = collectConfigMetrics(env({ SMS_PROVIDER: 'mokc' }));
    expect(m.unrecognisedProviderEnv).toBe(1);
    expect(m.deferredProviderEnv).toBe(1); // payment only
    expect(m.mockedProviderEnv).toBe(1);
  });

  it('deferrable providers on mock are a deferral, not a fault', () => {
    const m = collectConfigMetrics(env());
    expect(m.deferredProviderEnv).toBe(2); // SMS + payment
    expect(m.undeclaredMockProviderEnv).toBe(0);
  });

  it('THE REGRESSION: a mocked EMAIL provider is a FAULT, not a pause', () => {
    // Nobody can complete signup, reset a password, or receive an audit
    // digest. Reading "this is a deliberate pre-launch gate" off the string
    // `mock` is how that would have been reported in grey, forever.
    const m = collectConfigMetrics(env({ EMAIL_PROVIDER: 'mock' }));
    expect(m.undeclaredMockProviderEnv).toBe(1);
    expect(m.deferredProviderEnv).toBe(2); // SMS + payment remain accepted
    expect(PROVIDER_CONTRACT.EMAIL_PROVIDER.deferrable).toBe(false);
  });
});

describe('the deferral decision is recorded outside the code', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'deferred-features.md'), 'utf8');

  it('every provider names where its decision is written down', () => {
    for (const [name, c] of Object.entries(PROVIDER_CONTRACT)) {
      expect(c.decision, `${name} has no decision reference`).toBeTruthy();
      const [file] = c.decision.split(' ');
      expect(() => readFileSync(path.join(ROOT, file), 'utf8')).not.toThrow();
    }
  });

  it('the document states the same answer the code enforces', () => {
    const section = doc.slice(doc.indexOf('## Outbound providers'));
    expect(section, 'no Outbound providers section').toBeTruthy();
    for (const [name, c] of Object.entries(PROVIDER_CONTRACT)) {
      const row = section.split('\n').find((l) => l.includes(`\`${name}\``) && l.includes('|'));
      expect(row, `${name} has no row in the deferral table`).toBeTruthy();
      // The table says Yes/No; the code says true/false. They must agree.
      const docSaysDeferrable = /\*\*Yes\*\*/.test(row!);
      expect(docSaysDeferrable, `${name}: doc and PROVIDER_CONTRACT disagree`).toBe(c.deferrable);
    }
  });
});

describe('nothing leaks a value or a name off the server', () => {
  it('collectConfigMetrics returns numbers only', () => {
    for (const [k, v] of Object.entries(collectConfigMetrics(env()))) {
      expect(typeof v, `${k} is not a number`).toBe('number');
    }
  });

  it('providerRequiredEnv is server-side only and returns names, never values', () => {
    const names = providerRequiredEnv(env());
    expect(names).toContain('EMAIL_PROVIDER');
    expect(names).toContain('RESEND_API_KEY');
    // The values themselves are never returned.
    expect(names).not.toContain('resend');
    expect(names).not.toContain('test');
  });

  it('missingEnv reports names, and the metric reports only their count', () => {
    const e = env({ RESEND_API_KEY: undefined });
    expect(missingEnv(providerRequiredEnv(e), e)).toEqual(['RESEND_API_KEY']);
    expect(collectConfigMetrics(e).missingProviderCredentialEnv).toBe(1);
  });
});
