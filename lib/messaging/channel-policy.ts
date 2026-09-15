import type { MessageChannel } from '@prisma/client';
import { PROVIDER_CONTRACT, providerState } from '@/lib/provider-contract';

// -----------------------------------------------------------------------------
// ONE authority for "which reminder channels are live right now".
//
// Incident #90 was not a delivery failure. The UAT reminder email was
// delivered, with SPF, DKIM (d=send.bookpitch.ge) and DMARC all passing — and
// the monitor still reported the appointment as never reminded, because three
// modules disagreed about what `SMS_PROVIDER=mock` means:
//
//   reminders.ts   `CHANNELS = ['sms','email']`, both attempted unconditionally
//   reminders.ts   no phone -> message_log(state='failed', to_address='')
//                  i.e. a DATA condition written as a PROVIDER failure, and
//                  `failed` is outside the dedup set, so every tick added one
//   ops-metrics.ts missed-reminder SQL hard-coded ARRAY['sms','email'] as
//                  required, so a delivered email could not clear the check
//
// `mock` is a documented deferral for SMS (PROVIDER_CONTRACT marks it
// `deferrable: true`, recorded in docs/deferred-features.md § Outbound
// providers). A deferred channel must not be dialled, must not manufacture
// failure rows, and must not be owed by the metric.
//
// The danger in adding a "deferred" disposition is that it becomes a soft
// landing for configuration nobody checked. It is therefore reachable ONLY
// from a provider variable that literally says `mock` on a channel the
// contract allows to be deferred. Missing, blank, unrecognised, or mocked
// where the contract forbids it all THROW — same fail-closed posture as
// `getSmsProvider()` / `getEmailProvider()` in ./index.ts, which is what
// actually runs at send time.
// -----------------------------------------------------------------------------

/** Every channel the product can remind on, in a stable order. */
export const ALL_REMINDER_CHANNELS: readonly MessageChannel[] = ['sms', 'email'] as const;

/** The provider variable that decides whether a channel is live. */
const CHANNEL_PROVIDER_ENV: Readonly<Record<MessageChannel, string>> = {
  sms: 'SMS_PROVIDER',
  email: 'EMAIL_PROVIDER',
};

export type ChannelDisposition =
  /** A real adapter is configured. Attempt it, and require it. */
  | 'enabled'
  /** Explicitly `mock` on a channel the contract permits to ship deferred. */
  | 'deferred';

/**
 * Configuration that must stop the caller rather than be interpreted.
 *
 * Distinct from `InvalidInputError`: nothing a customer typed can cause this,
 * and it is never the appointment's fault.
 */
export class ReminderChannelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderChannelConfigError';
  }
}

/**
 * Is this channel live?
 *
 * Throws rather than guessing. The variable NAME may appear in the message —
 * it is already public in this repository — but never its value.
 */
export function reminderChannelDisposition(
  channel: MessageChannel,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChannelDisposition {
  const variable = CHANNEL_PROVIDER_ENV[channel];
  /* istanbul ignore next — unreachable while MessageChannel has two members */
  if (!variable)
    throw new ReminderChannelConfigError(`No provider variable for channel ${channel}`);

  const state = providerState(variable, env);
  const isProduction = env.NODE_ENV === 'production';

  if (state === 'real') return 'enabled';

  if (state === 'unrecognised') {
    throw new ReminderChannelConfigError(
      `${variable} names no adapter this build implements — a typo is not a deferral`,
    );
  }

  // Outside production this mirrors resolveProviderName() in ./index.ts, which
  // treats an unset variable as `mock`.
  if (state === 'missing' && isProduction) {
    throw new ReminderChannelConfigError(
      `${variable} is not set — refusing to guess whether ${channel} reminders are deferred`,
    );
  }

  // `mock`, or unset outside production.
  //
  // DEFERRAL IS A PRODUCTION-ONLY DECISION, and getting this wrong is easy.
  // The mock adapters are not inert: they return a provider message id without
  // contacting anyone, so in development and CI a mocked channel genuinely
  // reaches `sent` and the missed-reminder metric can still be exercised
  // against it. Calling it `deferred` there would have emptied the required set
  // in every test environment and made the metric structurally incapable of
  // reporting a miss — a false green, which is the failure this whole change
  // exists to remove, reintroduced one layer down.
  //
  // In PRODUCTION the same value means the opposite: the operator has decided
  // not to ship this channel (docs/deferred-features.md § Outbound providers),
  // getSmsProvider() refuses to return the mock adapter, and nothing can be
  // delivered. Only there is it a deferral, and only for a channel the contract
  // permits to be deferred.
  if (!isProduction) return 'enabled';

  if (!PROVIDER_CONTRACT[variable]?.deferrable) {
    throw new ReminderChannelConfigError(
      `${variable}=mock is not permitted in production — ${PROVIDER_CONTRACT[variable]?.decision ?? 'nothing would be delivered'}`,
    );
  }
  return 'deferred';
}

/**
 * The channels a tick should actually dial.
 *
 * Order follows ALL_REMINDER_CHANNELS so tallies and logs stay comparable
 * between runs.
 */
export function enabledReminderChannels(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MessageChannel[] {
  return ALL_REMINDER_CHANNELS.filter(
    (channel) => reminderChannelDisposition(channel, env) === 'enabled',
  );
}

/**
 * The channels the missed-reminder metric is allowed to demand.
 *
 * Identical to the enabled set, and that identity is the point: before #90 the
 * sender and the metric held different lists, so the system could do exactly
 * what it was configured to do and still be reported as broken.
 *
 * It is a separate exported name because the two answer different questions —
 * "what should I dial" and "what counts as owed" — and a future channel that is
 * best-effort rather than owed would diverge here and nowhere else.
 */
export function requiredReminderChannels(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MessageChannel[] {
  return enabledReminderChannels(env);
}
