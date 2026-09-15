import { describe, it, expect } from 'vitest';
import {
  reminderChannelDisposition,
  enabledReminderChannels,
  requiredReminderChannels,
  ReminderChannelConfigError,
} from '@/lib/messaging/channel-policy';

// -----------------------------------------------------------------------------
// Incident #90 — one authoritative reminder-channel policy.
//
// Production ships SMS_PROVIDER=mock as a documented deferral
// (docs/deferred-features.md § Outbound providers; PROVIDER_CONTRACT marks it
// `deferrable: true`). Before this policy existed, three separate places
// disagreed about what that means:
//
//   lib/messaging/reminders.ts   CHANNELS = ['sms','email'] — both ALWAYS
//                                attempted, so a deferred channel still ran
//   sendForAppointment()         a customer with no phone produced
//                                message_log(state='failed', to_address='')
//                                — a DATA condition recorded as a PROVIDER
//                                failure, and `failed` is not in the dedup
//                                set, so every later tick wrote another one
//   lib/ops-metrics.ts           the missed-reminder SQL hard-coded
//                                ARRAY['sms','email'] as required, so an
//                                appointment whose EMAIL was delivered was
//                                still counted as unreminded because the
//                                deferred SMS had no 'sent' row
//
// That last disagreement is what opened #90 while the UAT reminder email had
// demonstrably been delivered. The fix is not to special-case the metric: it is
// for one module to answer "which channels are live right now", and for the
// sender, the tally, the metric and the UI to all ask it.
//
// `deferred` must never be reachable by accident. Missing and unrecognised
// configuration still throws — a typo in SMS_PROVIDER is not a deferral.
// -----------------------------------------------------------------------------

const base = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  EMAIL_PROVIDER: 'resend',
  SMS_PROVIDER: 'mock',
  ...over,
});

describe('reminder channel policy', () => {
  it('treats a documented mock provider as deferred, not as something to attempt', () => {
    expect(reminderChannelDisposition('sms', base())).toBe('deferred');
  });

  it('treats a real configured adapter as enabled', () => {
    expect(reminderChannelDisposition('sms', base({ SMS_PROVIDER: 'smsoffice' }))).toBe('enabled');
    expect(reminderChannelDisposition('email', base())).toBe('enabled');
  });

  it('is case-insensitive about the adapter name, like the resolver is', () => {
    expect(reminderChannelDisposition('sms', base({ SMS_PROVIDER: 'MOCK' }))).toBe('deferred');
    expect(reminderChannelDisposition('sms', base({ SMS_PROVIDER: 'SMSOffice' }))).toBe('enabled');
  });

  // ---- fail closed -----------------------------------------------------------
  //
  // The whole risk of introducing "deferred" is that it becomes a soft landing
  // for configuration nobody checked. These four cases are the complement.

  it('THROWS when the provider variable is unset in production — absence is not a deferral', () => {
    expect(() => reminderChannelDisposition('sms', base({ SMS_PROVIDER: undefined }))).toThrow(
      ReminderChannelConfigError,
    );
    expect(() => reminderChannelDisposition('sms', base({ SMS_PROVIDER: '   ' }))).toThrow(
      ReminderChannelConfigError,
    );
  });

  it('THROWS on an unrecognised provider name — a typo is not a deferral', () => {
    expect(() => reminderChannelDisposition('sms', base({ SMS_PROVIDER: 'mokc' }))).toThrow(
      ReminderChannelConfigError,
    );
    expect(() => reminderChannelDisposition('email', base({ EMAIL_PROVIDER: 'sendgrid' }))).toThrow(
      ReminderChannelConfigError,
    );
  });

  it('THROWS when a NON-deferrable channel is mocked in production', () => {
    // PROVIDER_CONTRACT.EMAIL_PROVIDER.deferrable === false. Signup
    // verification and password reset ride the same provider, so a mocked
    // email provider in production is a fault, never a pause.
    expect(() => reminderChannelDisposition('email', base({ EMAIL_PROVIDER: 'mock' }))).toThrow(
      ReminderChannelConfigError,
    );
  });

  it('treats mock as ENABLED outside production — the mock adapter really does send', () => {
    // Deferral is a production-only decision, and this is the trap in it.
    //
    // The mock adapters are not inert: they return a provider message id
    // without contacting anyone, so in dev and CI a mocked channel genuinely
    // reaches `sent`. Calling it `deferred` here would empty the required set
    // in every test environment, and the missed-reminder metric would become
    // structurally incapable of reporting a miss — the same false green this
    // change exists to remove, one layer down. The existing reminder suites
    // caught exactly that.
    const dev = base({ NODE_ENV: 'development', EMAIL_PROVIDER: 'mock', SMS_PROVIDER: 'mock' });
    expect(reminderChannelDisposition('email', dev)).toBe('enabled');
    expect(reminderChannelDisposition('sms', dev)).toBe('enabled');
    expect(requiredReminderChannels(dev).slice().sort()).toEqual(['email', 'sms']);
  });

  it('treats an unset variable outside production the way the resolver does', () => {
    // resolveProviderName() in ./index.ts defaults to `mock` outside
    // production. Diverging from the thing that actually runs is how the
    // previous contract bug happened.
    const dev = base({ NODE_ENV: 'test', SMS_PROVIDER: undefined });
    expect(reminderChannelDisposition('sms', dev)).toBe('enabled');
  });

  // ---- what the rest of the system consumes ----------------------------------

  it('enabledReminderChannels omits the deferred channel', () => {
    expect(enabledReminderChannels(base())).toEqual(['email']);
  });

  it('enabledReminderChannels includes both once SMS is really configured', () => {
    const live = base({ SMS_PROVIDER: 'smsoffice' });
    expect(enabledReminderChannels(live).slice().sort()).toEqual(['email', 'sms']);
  });

  it('requiredReminderChannels equals the enabled set — a deferred channel is never owed', () => {
    // This is the exact assertion #90 needed. The metric must require what is
    // live, not what the enum happens to contain.
    expect(requiredReminderChannels(base())).toEqual(['email']);
    expect(
      requiredReminderChannels(base({ SMS_PROVIDER: 'smsoffice' }))
        .slice()
        .sort(),
    ).toEqual(['email', 'sms']);
  });

  it('never returns an empty required set in production', () => {
    // Email is non-deferrable, so "nothing is required" is unreachable without
    // a throw. If this ever passes with [], the metric would go permanently
    // green and stop being able to report a missed reminder at all.
    expect(() => {
      const req = requiredReminderChannels(base({ EMAIL_PROVIDER: 'mock' }));
      expect(req).not.toEqual([]);
    }).toThrow(ReminderChannelConfigError);
  });
});
