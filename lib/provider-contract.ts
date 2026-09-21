// -----------------------------------------------------------------------------
// The outbound-provider contract.
//
// EXTRACTED FROM lib/ops-metrics.ts and deliberately kept dependency-free.
//
// lib/ops-metrics.ts already imports from lib/messaging/, and after incident
// #90 it also needs to know which reminder channels are live. That answer
// belongs in lib/messaging/channel-policy.ts, which needs this table — so
// leaving the table in ops-metrics would have made
// ops-metrics -> channel-policy -> ops-metrics a cycle.
//
// This file imports NOTHING. It is the bottom of that graph, and it is the one
// place that decides what a provider variable means. ops-metrics re-exports
// every name below, so existing importers and tests are unaffected.
// -----------------------------------------------------------------------------

/**
 * The full outbound-provider contract: which adapters exist, what each one
 * needs, and whether the product is allowed to launch without it.
 *
 * Three gaps this closes, all of which let production look configured while a
 * resolver would fail closed at the first real send:
 *
 *   1. PAYMENT_GATEWAY and SMS_PROVIDER were in NO required-variable set, so
 *      unsetting either was invisible. `missingSignupEnv/Email/Security` all
 *      stayed 0 and the monitor reported the configuration complete, while
 *      getGateway() and getSmsProvider() throw in production on an unset
 *      variable ("refusing to default to the mock provider").
 *   2. Nothing checked the credentials the SELECTED adapter actually reads.
 *      EMAIL_PROVIDER=postmark passed every check with POSTMARK_API_TOKEN
 *      unset; the first send would throw.
 *   3. `mock` was treated as an acceptable pre-launch state for any provider,
 *      inferred from the value alone. Whether a feature may ship deferred is a
 *      product decision, not something to read off an environment variable.
 *      `deferrable` records that decision here and is the only thing that
 *      permits a PAUSED status; docs/deferred-features.md § Outbound providers
 *      is the authoritative statement it mirrors.
 */
export const PROVIDER_CONTRACT: Readonly<
  Record<
    string,
    {
      /** Adapter name → the variables that adapter reads. */
      readonly adapters: Readonly<Record<string, readonly string[]>>;
      /**
       * Whether shipping on the `mock` adapter is an accepted deferral.
       * False means `mock` is a FAULT, not a pause.
       */
      readonly deferrable: boolean;
      /** Where the deferral decision is recorded, for the operator. */
      readonly decision: string;
    }
  >
> = {
  EMAIL_PROVIDER: {
    adapters: {
      resend: ['RESEND_API_KEY', 'RESEND_FROM'],
      postmark: ['POSTMARK_API_TOKEN', 'POSTMARK_FROM'],
    },
    // Email is not deferrable: signup verification, password reset and the
    // audit digest all go through it. A mocked email provider in production
    // means nobody can complete signup.
    deferrable: false,
    decision: 'docs/deferred-features.md § Outbound providers',
  },
  SMS_PROVIDER: {
    adapters: { smsoffice: ['SMSOFFICE_API_KEY', 'SMSOFFICE_SENDER'] },
    deferrable: true,
    decision: 'docs/deferred-features.md § Outbound providers',
  },
  PAYMENT_GATEWAY: {
    adapters: {
      bog: ['BOG_CLIENT_ID', 'BOG_CLIENT_SECRET', 'BOG_WEBHOOK_PUBLIC_KEY'],
      bog_ipay: ['BOG_CLIENT_ID', 'BOG_CLIENT_SECRET', 'BOG_WEBHOOK_PUBLIC_KEY'],
      tbc: ['TBC_API_KEY', 'TBC_CLIENT_ID', 'TBC_CLIENT_SECRET', 'TBC_WEBHOOK_SECRET'],
      tbc_ecommerce: ['TBC_API_KEY', 'TBC_CLIENT_ID', 'TBC_CLIENT_SECRET', 'TBC_WEBHOOK_SECRET'],
    },
    deferrable: true,
    decision: 'docs/deferred-features.md § Outbound providers',
  },
};

/** How a provider variable is set, which decides how it must be reported. */
export type ProviderState =
  /** Unset or empty. The resolver throws in production. */
  | 'missing'
  /** Literally `mock`. A decision if deferrable, a fault otherwise. */
  | 'mock'
  /** Names an adapter the resolver implements. */
  | 'real'
  /** Set to something no resolver knows. A typo; throws at first send. */
  | 'unrecognised';

export function providerState(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderState {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return 'missing';
  if (raw === 'mock') return 'mock';
  const contract = PROVIDER_CONTRACT[name];
  if (contract && Object.prototype.hasOwnProperty.call(contract.adapters, raw)) return 'real';
  return 'unrecognised';
}

/**
 * The variables the SELECTED adapter will actually read.
 *
 * Empty for every state but `real`: there is no point demanding Postmark
 * credentials from a deployment that has chosen Resend, and a provider that is
 * missing or mocked is reported by its own state rather than by a pile of
 * credential variables nothing would read.
 */
export function requiredProviderCredentials(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  if (providerState(name, env) !== 'real') return [];
  const adapter = (env[name] ?? '').trim().toLowerCase();
  return PROVIDER_CONTRACT[name]?.adapters[adapter] ?? [];
}

/** Every provider variable, plus the credentials whichever adapter is selected needs. */
export function providerRequiredEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.keys(PROVIDER_CONTRACT).flatMap((name) => [
    name,
    ...requiredProviderCredentials(name, env),
  ]);
}
