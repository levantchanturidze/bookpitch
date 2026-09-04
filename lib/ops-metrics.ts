// Group C: operational probe — no session, cross-tenant counts only. The
// no-restricted-imports rule that used to need a disable here no longer
// reports on this import, and an unused disable is itself a lint warning.
import { unsafePrismaAdmin } from '@/lib/db';
import { auditDigestDeliveryMode, isAuditDigestDeliveryEnabled } from '@/lib/audit-digest';
import { OWED_MIN_LEAD_MINUTES } from '@/lib/messaging/reminder-eligibility';
import {
  HEARTBEAT_JOBS,
  HEARTBEAT_MAX_AGE_MINUTES,
  HEARTBEAT_METRIC_KEY,
} from '@/lib/cron-heartbeat-jobs';

// -----------------------------------------------------------------------------
// Operational metrics for the production monitor.
//
// Everything here is a COUNT or an AGE. No message body, no recipient, no
// token, no IP address, no tenant identifier, no customer row ever leaves this
// module — see tests/ops-metrics.test.ts, which asserts the shape is entirely
// numeric so a future field cannot quietly smuggle a string out.
//
// The monitor calls GET /api/health/ops with the cron bearer secret every 30
// minutes. Each query below is a single indexed aggregate against production;
// the whole collection is one round trip's worth of work.
//
// Why these particular numbers: each one is a *symptom* of a scheduled job
// having stopped, not a restatement of whether the job's HTTP call returned
// 200. A cron that returns 200 while doing nothing is the failure mode this
// project has already been bitten by (CLAUDE.md, 2026-08-06) — so the monitor
// watches the database state the job is supposed to be changing.
// -----------------------------------------------------------------------------

export type OutboxMetrics = {
  /** Rows waiting to be sent. Normal steady state is 0 or a small number. */
  pending: number;
  /** Rows a worker has claimed. Should drain within one housekeeping tick. */
  processing: number;
  /** Dead letters: retries exhausted. Any value > 0 wants a human. */
  dead: number;
  /** Claims whose lease has expired — a worker died mid-send. */
  staleClaims: number;
  /** Age of the oldest pending row, seconds. Null when the queue is empty. */
  oldestPendingAgeSeconds: number | null;
  /** Dead letters created in the last 24h — distinguishes new from historical. */
  deadLast24h: number;
  /** Dead rows that hit max_attempts, i.e. retry limiting is working. */
  deadWithExhaustedRetries: number;
};

export type HousekeepingMetrics = {
  /**
   * Rows housekeeping should already have deleted. Housekeeping prunes
   * rate_limit rows older than 1 day; anything older than 2 days means the
   * hourly job has not run successfully for at least a day.
   */
  overdueRateLimitRows: number;
  /** Same idea for verification tokens whose `expires` passed over a day ago. */
  overdueExpiredTokens: number;
  /** Reauth grants that should have been swept (consumed/expired > 2 days). */
  overdueReauthGrants: number;
};

export type RetentionMetrics = {
  /**
   * Customers past their organisation's retention window that are still
   * carrying PII. The nightly retention cron drives this to 0; a non-zero
   * value that persists across days is a GDPR problem, not just a late job.
   */
  overdueCustomers: number;
};

export type AuditDigestMetrics = {
  /** Hours since the weekly digest last queued mail. Null if never queued. */
  hoursSinceLastQueued: number | null;
  /**
   * Age, in hours, of the oldest organization that is actually eligible for a
   * digest (has at least one owner membership with an email address). Null
   * when no such organization exists.
   *
   * P15-003: without this, `hoursSinceLastQueued === null` was indistinguishable
   * between "brand new deployment, nothing due yet" and "the weekly job has
   * never once fired". The monitor treated both as healthy, so a digest that
   * never ran at all was invisible forever. Pairing the two numbers makes
   * "a digest has been due for N hours and none was ever queued" detectable.
   */
  oldestEligibleOrgAgeHours: number | null;
  /**
   * How many owner mailboxes would receive a digest on the next run.
   *
   * P15-004 put the digest on the hourly schedule, so once
   * FIELD_ENCRYPTION_KEY is corrected it fires automatically rather than being
   * manually triggered. This makes the blast radius knowable in advance —
   * a count, never an address — so nobody discovers how many real people got
   * mail by watching it arrive.
   */
  /**
   * Eligible organization-owner MEMBERSHIP rows: role='owner' with a non-null
   * email. One person owning three organizations contributes three.
   */
  eligibleOwnerMemberships: number;
  /**
   * Organizations that would actually produce at least one message — i.e.
   * those with at least one emailable owner. runDigestForAllOrgs() builds a
   * digest for every organization, but only these generate an intent.
   */
  eligibleOrganizations: number;
  /**
   * Distinct normalized (lower-cased, trimmed) recipient addresses. This is
   * the number of human inboxes involved, regardless of how many memberships
   * or organizations they hold.
   */
  distinctNormalizedRecipientAddresses: number;
  /**
   * Outbox intents a single enabled run would create.
   *
   * sendDigestToOwners() writes one row per (organization, address) pair, and
   * the unique idempotency key collapses duplicates within an ISO week. So
   * this is COUNT(DISTINCT (organization_id, normalized address)) — not the
   * membership count and not the address count.
   */
  expectedDigestMessagesPerRun: number;
  /**
   * 1 when AUDIT_DIGEST_ENABLED is exactly "true", else 0.
   *
   * Delivery is gated off until the production recipients are reconciled. The
   * monitor needs this to report PAUSE rather than a misleading PASS or a FAIL
   * for a job that is deliberately stopped.
   */
  deliveryEnabled: number;
  /**
   * 1 when AUDIT_DIGEST_ENABLED holds a value that is neither the enable
   * literal nor a recognised off value. Delivery stays off either way.
   */
  deliveryConfigMalformed: number;
  // ---------------------------------------------------------------------
  // Classification of the DISTINCT normalized addresses. Mutually exclusive
  // by precedence — fixture domain wins, then reserved TLD, then the rest —
  // so the three sum exactly to distinctNormalizedRecipientAddresses and can
  // be reasoned about as a partition rather than overlapping tags.
  // ---------------------------------------------------------------------
  /** Addresses at this repository's seed/fixture domains. */
  knownFixtureDomain: number;
  /** Not a fixture domain, but at an RFC 2606 / RFC 6761 reserved TLD. */
  reservedTldNonFixture: number;
  /** Neither. These are the addresses that could belong to a real person. */
  otherUnclassified: number;
  // ---------------------------------------------------------------------
  // Second-pass classification of otherUnclassified.
  //
  // otherUnclassified > 0 does NOT establish that a real customer exists — it
  // only means the address was not matched by the fixture-domain rules. An
  // operator's own mailbox, a personal test account and a genuine customer all
  // land there. These narrow it further, still with counts only.
  // ---------------------------------------------------------------------
  /** `otherUnclassified` addresses at the operator's own domain (bookpitch.ge). */
  otherAtOperatorDomain: number;
  /** Distinct domains across the `otherUnclassified` addresses. */
  otherDistinctDomains: number;
  /**
   * Eligible organizations holding zero customer records. A dormant
   * organization is evidence the account is not in real use, independent of
   * what its owner's address looks like.
   */
  eligibleOrganizationsWithNoCustomers: number;
};

/**
 * How many rows currently hold field-level ciphertext.
 *
 * P15-010: prefixing FIELD_ENCRYPTION_KEY with a key id preserves the AES key
 * bytes, so existing ciphertext keeps decrypting — but only if that ciphertext
 * was written with the SAME bytes. If any ciphertext predates the present
 * value, the correction could make it unreadable. Counts only, never values,
 * so "is there anything at risk?" is answerable before a human edits the
 * secret.
 */
export type CiphertextMetrics = {
  /** customers.allergies / clinical_notes holding a non-null value. */
  customerFields: number;
  /** email_outbox rows with an encrypted recipient or body. */
  outboxRows: number;
  /** app_users rows with a stored or pending TOTP secret. */
  mfaSecrets: number;
  /** Sum of the three — zero means the format correction risks nothing. */
  total: number;
};

export type PartitionMetrics = {
  /** Whole months of audit_log partitions that exist beyond the current one. */
  monthsAhead: number;
  /** Rows that landed in audit_log_default — always a partition-gap symptom. */
  defaultPartitionRows: number;
};

export type ConfigMetrics = {
  /** Required-but-unset environment variables for the public signup path. */
  missingSignupEnv: number;
  /** Required-but-unset environment variables for outbound email. */
  missingEmailEnv: number;
  /** Required-but-unset environment variables for auth/crypto/cron. */
  missingSecurityEnv: number;
  /**
   * Required-but-unset environment variables for error reporting.
   *
   * Non-zero means uncaught exceptions are going nowhere: the SDK is present
   * and initialises only behind a DSN check, so an absent DSN is silent
   * blindness rather than a visible failure.
   */
  missingObservabilityEnv: number;
  /**
   * Environment variables that are SET but structurally unusable.
   *
   * P15-010: production had FIELD_ENCRYPTION_KEY set without its `<key-id>:`
   * prefix. `missingSecurityEnv` was 0 and the monitor reported the
   * configuration complete, while every call to encryptField() threw
   * `FIELD_ENCRYPTION_KEY must be "<key-id>:<64-hex-chars>"` — which is to say
   * signup, patient clinical fields and MFA enrolment were all broken in
   * production. Nothing noticed for weeks because none of those paths had ever
   * run there.
   *
   * Presence is not validity. This counts the difference.
   */
  invalidSecurityEnv: number;
  /**
   * Providers deliberately left on the `mock` adapter before launch.
   *
   * Reported, never counted as a fault: `getGateway()` and the messaging
   * resolvers refuse `mock` in production, so the runtime already fails closed.
   * This number is how an operator sees it before a customer does.
   */
  mockedProviderEnv: number;
  /**
   * Providers set to a value that is neither a real adapter nor `mock`.
   *
   * A typo. Non-zero is a fault: the resolver throws at the first send, and
   * nothing earlier says so.
   */
  unrecognisedProviderEnv: number;
  /**
   * Provider variables that are UNSET.
   *
   * PAYMENT_GATEWAY and SMS_PROVIDER belonged to no required-variable set, so
   * unsetting either was completely invisible: every `missing*` count stayed 0
   * and the monitor called the configuration complete. Meanwhile getGateway()
   * and getSmsProvider() throw in production on an unset variable, so the
   * feature was dead and the only report of it was a 500 nobody would read.
   */
  missingProviderEnv: number;
  /**
   * Credentials the SELECTED adapter reads and does not have.
   *
   * EMAIL_PROVIDER=postmark used to satisfy every check while
   * POSTMARK_API_TOKEN was unset, because the email requirement list was
   * hard-coded to Resend. Resolved against the chosen adapter now.
   */
  missingProviderCredentialEnv: number;
  /**
   * Providers on `mock` where deferral IS an accepted decision.
   *
   * The only state that may be reported as PAUSED.
   */
  deferredProviderEnv: number;
  /**
   * Providers on `mock` where deferral is NOT accepted.
   *
   * A fault. Email is the case that matters: a mocked email provider means
   * nobody can complete signup, and inferring "this is fine, it is pre-launch"
   * from the value `mock` is how that would be reported as a deliberate pause.
   */
  undeclaredMockProviderEnv: number;
};

/**
 * Minutes since each cron job last COMPLETED, as recorded by the job itself.
 *
 * Distinct from the GitHub Actions run list, which reports invocation: a
 * workflow can be queued, curl can exit 0, and the endpoint can have processed
 * nothing. null means the job has never written a heartbeat — a fresh
 * deployment, or a job that has genuinely never completed.
 */
export type CronHeartbeatMetrics = {
  /** Minutes since each job last SUCCEEDED. Only a success advances this. */
  remindersMinutesAgo: number | null;
  housekeepingMinutesAgo: number | null;
  retentionMinutesAgo: number | null;
  auditDigestMinutesAgo: number | null;
  /** Units the last reminder tick completed. */
  remindersLastUnits: number | null;
  /**
   * Outcome of the last reminders ATTEMPT, as a number so the response stays
   * numeric-only: 1 success, 0 partial, -1 failure, null unknown/absent.
   *
   * Age alone cannot see a job that is attempted every 15 minutes and fails
   * every time — `last_succeeded_at` simply stops moving, and for the first
   * six hours that is indistinguishable from a healthy quiet period.
   */
  remindersLastOutcome: number | null;
  /** Units the last reminders attempt expected, and how many failed. */
  remindersExpectedUnits: number | null;
  remindersFailedUnits: number | null;
  /** Minutes since the last reminders ATTEMPT, successful or not. */
  remindersAttemptMinutesAgo: number | null;
  /** Jobs whose most recent attempt was not a success. Kept for older monitors. */
  jobsNotSucceeding: number | null;
  /**
   * Per-job state, one entry for EVERY required job whether or not a row
   * exists. Numeric-only, like everything else here.
   *
   * `present` 0 means the job has never written a heartbeat at all — which the
   * previous scalar could not express, because it counted only existing rows
   * with a bad outcome. A missing row read as healthy.
   */
  jobs: Record<
    string,
    {
      present: number;
      /** 1 success, 0 partial, -1 failure, null unknown/absent. */
      outcome: number | null;
      successMinutesAgo: number | null;
      /** Absolute UTC instant of the last success, from the DB clock. */
      successAtEpochMs: number | null;
      attemptMinutesAgo: number | null;
      expectedUnits: number | null;
      processedUnits: number | null;
      failedUnits: number | null;
      /** The cadence limit this job is held to, in minutes. */
      maxAgeMinutes: number;
    }
  > | null;
  /**
   * Appointments that have already STARTED without any reminder ever being
   * logged, inside the window their organization's lead time covered.
   *
   * This is the one reminder failure a sliding window cannot heal. The window
   * is [now, now + reminderLeadHours] recomputed each tick, so a scheduler gap
   * shorter than the lead time is harmless for FUTURE appointments — a later
   * tick's window still contains them. But an appointment that starts DURING
   * the gap leaves the window permanently, and no later tick can catch it.
   *
   * It cannot be undone, so it must at least be visible. Counting it directly
   * is the only honest check: heartbeat freshness, cron success and workflow
   * conclusions can all be green while this is non-zero.
   */
  unremindedStartedAppointments: number | null;
};

export type OpsMetrics = {
  outbox: OutboxMetrics;
  housekeeping: HousekeepingMetrics;
  retention: RetentionMetrics;
  auditDigest: AuditDigestMetrics;
  ciphertext: CiphertextMetrics;
  partitions: PartitionMetrics;
  cronHeartbeat: CronHeartbeatMetrics;
  config: ConfigMetrics;
};

// -----------------------------------------------------------------------------
// Production configuration contract.
//
// Phase 13 found production signup completely broken because two env vars were
// never set: verifyTurnstile() fails closed when TURNSTILE_EXPECTED_ACTION or
// TURNSTILE_ALLOWED_HOSTNAMES is absent in production, so every signup returned
// 400 "invalid request". Nothing observed that. The application logged an error
// nobody read, and no test could see it because tests set their own env.
//
// These lists turn "is production configured" into a number the monitor watches
// every 30 minutes. Only the COUNT is ever exposed — variable names stay here,
// in the repository, where they are already public to anyone who can read it,
// and never travel in an HTTP response.
// -----------------------------------------------------------------------------

export const REQUIRED_SIGNUP_ENV = [
  'TURNSTILE_SECRET_KEY',
  // Without these two, verifyTurnstile() returns false for every request in
  // production. They are the reason this list exists.
  'TURNSTILE_EXPECTED_ACTION',
  'TURNSTILE_ALLOWED_HOSTNAMES',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
] as const;

/**
 * Outbound email.
 *
 * This used to be a flat `['EMAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_FROM']`,
 * which is wrong in both directions the moment Postmark is selected:
 * getEmailProvider() accepts `postmark` and then requires POSTMARK_API_TOKEN
 * and POSTMARK_FROM, neither of which was checked, while two Resend variables
 * that nothing would read were reported as missing. The check disagreed with
 * the resolver, and the resolver is the one that runs.
 *
 * Resolved against the selected provider instead — see PROVIDER_CONTRACT.
 */
export const REQUIRED_EMAIL_ENV = ['EMAIL_PROVIDER'] as const;

/**
 * P17-007. Sentry initialises only when a DSN is present — every Sentry.init()
 * in this repository is inside `if (process.env.…_DSN)`. Production had
 * SENTRY_ENVIRONMENT and NEXT_PUBLIC_SENTRY_ENVIRONMENT set and neither DSN,
 * so the SDK was installed, the config files existed, instrumentation.ts
 * exported onRequestError — and application error reporting was a no-op. That
 * is the same shape as P15-010: everything looks configured, nothing reports.
 *
 * Both halves are listed. Server errors are the more critical, but a stack
 * with browser reporting silently off is exactly the "healthy signal that
 * means nothing" this list exists to prevent.
 */
export const REQUIRED_OBSERVABILITY_ENV = ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN'] as const;

export const REQUIRED_SECURITY_ENV = [
  'AUTH_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'RATE_LIMIT_HMAC_KEY',
  'EMAIL_PRIVACY_HMAC_KEY',
  'CRON_SECRET',
] as const;

/** Names of the required variables that are unset or empty. Server-side only. */
export function missingEnv(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return names.filter((name) => !(env[name] ?? '').trim());
}

/**
 * Structural validators for secrets whose FORMAT is knowable without knowing
 * the value. Each returns true when the value is usable.
 *
 * Deliberately format-only: nothing here can confirm a key is the *correct*
 * key, only that the code which parses it will not throw. That is exactly the
 * failure P15-010 was — a well-formed-looking value that every consumer
 * rejected at the first byte.
 */
/**
 * Structural validators for the cryptographic and auth secrets.
 *
 * A failure here is a P0: the value is present, so `missingEnv()` says the
 * configuration is complete, and the application throws at the first call that
 * uses it. P15-010 was exactly this — FIELD_ENCRYPTION_KEY set without its
 * `<key-id>:` prefix, signup returning 500, and nothing reporting it for weeks.
 */
export const SECRET_ENV_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  // lib/crypto.ts parseKeySpec: "<key-id>:<64-hex-chars>", key-id non-empty.
  FIELD_ENCRYPTION_KEY: (v) => {
    const colon = v.indexOf(':');
    if (colon < 1) return false;
    return /^[0-9a-fA-F]{64}$/.test(v.slice(colon + 1));
  },
  // lib/crypto.ts: 32 bytes as 64 hex chars, no key-id prefix.
  EMAIL_PRIVACY_HMAC_KEY: (v) => /^[0-9a-fA-F]{64}$/.test(v),
  RATE_LIMIT_HMAC_KEY: (v) => /^[0-9a-fA-F]{64}$/.test(v),
  // Auth.js refuses anything trivially short.
  AUTH_SECRET: (v) => v.length >= 32,
};

/**
 * The outbound adapters. Separate from the secrets above, and the separation is
 * the point.
 *
 * F16-001/002 put these in the same table, so "a payment gateway we have not
 * launched is still on the mock adapter" and "the encryption key is malformed,
 * signup is returning 500" arrived on one status line, under one title — "A
 * required secret is set but structurally unusable". They are not the same
 * event and must not share a line, for the reason
 * `production-observability-unconfigured` is already its own check: an
 * operator who learns to expect that line to be red stops reading it.
 *
 * A provider on `mock` before launch is a deliberate state, reported as PAUSED.
 * A provider set to something that is neither a real adapter nor `mock` is a
 * typo and a fault, and is reported as one. Absence is `missingEnv()`'s job —
 * `invalidEnv()` skips unset variables and the resolvers fail closed.
 */
export const PROVIDER_ENV_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  PAYMENT_GATEWAY: (v) => isRealProvider(v, ['bog', 'bog_ipay', 'tbc', 'tbc_ecommerce']),
  EMAIL_PROVIDER: (v) => isRealProvider(v, ['postmark', 'resend']),
  SMS_PROVIDER: (v) => isRealProvider(v, ['smsoffice']),
};

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

/**
 * Both tables together.
 *
 * Kept so a caller that wants "every structural validator" still has one name
 * for it. `collectConfigMetrics()` deliberately does NOT use it — it reports
 * the two halves separately.
 */
export const SECURITY_ENV_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  ...SECRET_ENV_VALIDATORS,
  ...PROVIDER_ENV_VALIDATORS,
};

/**
 * True when `value` names a real adapter. "mock" is rejected on purpose, and so
 * is any name the corresponding resolver would throw on — a typo'd provider is
 * as broken as a mocked one, and equally worth seeing before it matters.
 */
function isRealProvider(value: string, real: readonly string[]): boolean {
  return real.includes(value.trim().toLowerCase());
}

/**
 * Names of variables that are set but fail their structural validator.
 *
 * A variable that is absent is reported by missingEnv(), not here, so the two
 * counts do not double-report the same problem.
 */
export function invalidEnv(
  validators: Readonly<Record<string, (value: string) => boolean>> = SECURITY_ENV_VALIDATORS,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(validators)
    .filter(([name, isValid]) => {
      const raw = (env[name] ?? '').trim();
      if (!raw) return false; // absent — missingEnv's job
      return !isValid(raw);
    })
    .map(([name]) => name);
}

/**
 * Providers that are set to the literal `mock` adapter.
 *
 * Distinguished from a typo because the two need different responses: `mock`
 * before launch is a decision, `mokc` is a fault that will fail closed at the
 * first real send and nowhere earlier.
 */
export function mockedProviders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.keys(PROVIDER_ENV_VALIDATORS).filter(
    (name) => (env[name] ?? '').trim().toLowerCase() === 'mock',
  );
}

export function collectConfigMetrics(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigMetrics {
  const names = Object.keys(PROVIDER_CONTRACT);
  const stateOf = (n: string) => providerState(n, env);
  const mocked = names.filter((n) => stateOf(n) === 'mock');

  return {
    missingSignupEnv: missingEnv(REQUIRED_SIGNUP_ENV, env).length,
    // Provider-aware: EMAIL_PROVIDER plus whatever the selected adapter reads.
    missingEmailEnv: missingEnv(
      [...REQUIRED_EMAIL_ENV, ...requiredProviderCredentials('EMAIL_PROVIDER', env)],
      env,
    ).length,
    missingSecurityEnv: missingEnv(REQUIRED_SECURITY_ENV, env).length,
    missingObservabilityEnv: missingEnv(REQUIRED_OBSERVABILITY_ENV, env).length,
    // Secrets only. This is the number the P0 check reads, and folding the
    // providers into it is what made that check permanently red.
    invalidSecurityEnv: invalidEnv(SECRET_ENV_VALIDATORS, env).length,
    mockedProviderEnv: mocked.length,
    unrecognisedProviderEnv: names.filter((n) => stateOf(n) === 'unrecognised').length,
    missingProviderEnv: names.filter((n) => stateOf(n) === 'missing').length,
    missingProviderCredentialEnv: names.flatMap((n) =>
      missingEnv(requiredProviderCredentials(n, env), env),
    ).length,
    deferredProviderEnv: mocked.filter((n) => PROVIDER_CONTRACT[n].deferrable).length,
    undeclaredMockProviderEnv: mocked.filter((n) => !PROVIDER_CONTRACT[n].deferrable).length,
  };
}

/** Postgres aggregates come back as bigint; normalise to a JS number. */
function num(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return 0;
  return Number(value) || 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = num(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when an error is Postgres 42P01 (undefined_table).
 *
 * Checked in three places because Prisma does not present a raw Postgres error
 * consistently: depending on client version it surfaces as `code` on the
 * error, as `meta.code` inside a PrismaClientKnownRequestError (P2010), or
 * only in the message text. Matching just one would silently stop working on a
 * client upgrade — and it would fail OPEN, which is the worse direction: a
 * genuinely broken query would be reported as an empty table forever.
 *
 * Deliberately narrow. Anything that is not a missing table is a real failure
 * and must reach the caller.
 */
export function isUndefinedTableError(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  if (!e) return false;
  return (
    e.code === '42P01' ||
    e.meta?.code === '42P01' ||
    /\b42P01\b|relation "?[a-z_]+"? does not exist/i.test(String(e.message ?? ''))
  );
}

export async function collectOpsMetrics(): Promise<OpsMetrics> {
  // One statement per concern, all using the DB clock. Node's clock is not
  // authoritative for anything time-based in this project (see CLAUDE.md and
  // the reauth-expiry memory): a skewed runner must not be able to invent a
  // healthy-looking age.
  const [
    outboxRows,
    housekeepingRows,
    retentionRows,
    digestRows,
    ciphertextRows,
    partitionRows,
    heartbeatRows,
    unremindedRows,
  ] = await Promise.all([
    unsafePrismaAdmin.$queryRaw<
      Array<{
        pending: bigint;
        processing: bigint;
        dead: bigint;
        stale_claims: bigint;
        oldest_pending_age_seconds: number | null;
        dead_last_24h: bigint;
        dead_exhausted: bigint;
      }>
    >`
        SELECT
          count(*) FILTER (WHERE status = 'pending')                                  AS pending,
          count(*) FILTER (WHERE status = 'processing')                               AS processing,
          count(*) FILTER (WHERE status = 'dead')                                     AS dead,
          count(*) FILTER (WHERE status = 'processing' AND claim_expires_at < NOW())  AS stale_claims,
          EXTRACT(EPOCH FROM (NOW() - min(created_at) FILTER (WHERE status = 'pending')))::int
                                                                                      AS oldest_pending_age_seconds,
          count(*) FILTER (WHERE status = 'dead' AND failed_at > NOW() - interval '24 hours')
                                                                                      AS dead_last_24h,
          count(*) FILTER (WHERE status = 'dead' AND attempts >= max_attempts)        AS dead_exhausted
        FROM email_outbox
      `,

    unsafePrismaAdmin.$queryRaw<
      Array<{ overdue_rate_limit: bigint; overdue_tokens: bigint; overdue_reauth: bigint }>
    >`
        SELECT
          (SELECT count(*) FROM rate_limit WHERE window_start < NOW() - interval '2 days')
            AS overdue_rate_limit,
          (SELECT count(*) FROM verification_tokens WHERE expires < NOW() - interval '1 day')
            AS overdue_tokens,
          (SELECT count(*) FROM platform_reauth_grant
            WHERE (consumed_at IS NOT NULL OR expires_at < NOW())
              AND granted_at < NOW() - interval '2 days')
            AS overdue_reauth
      `,

    // Mirrors lib/gdpr.ts runRetentionTick: stale by updated_at against the
    // org's own window, not yet redacted, and with no appointment inside the
    // window. Counted, never selected.
    unsafePrismaAdmin.$queryRaw<Array<{ overdue_customers: bigint }>>`
        SELECT count(*) AS overdue_customers
        FROM customers c
        JOIN organizations o ON o.id = c.organization_id
        -- Same expression the executor uses, so the monitor cannot report a
        -- backlog retention was never going to clear. See lib/retention-window.ts.
        WHERE c.updated_at < ((date_trunc('day', (NOW() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC')
                              - make_interval(years => o.customer_retention_years))
          AND c.name NOT LIKE 'Redacted Customer #%'
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.customer_id = c.id
              AND a.starts_at >= ((date_trunc('day', (NOW() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC')
                                  - make_interval(years => o.customer_retention_years))
          )
      `,

    unsafePrismaAdmin.$queryRaw<
      Array<{
        hours_since: number | null;
        oldest_eligible_org_age_hours: number | null;
        eligible_owner_memberships: number;
        eligible_organizations: number;
        distinct_normalized_recipient_addresses: number;
        expected_digest_messages_per_run: number;
        known_fixture_domain: number;
        reserved_tld_non_fixture: number;
        other_unclassified: number;
        other_at_operator_domain: number;
        other_distinct_domains: number;
        eligible_organizations_with_no_customers: number;
      }>
    >`
        -- float8, not numeric: Prisma maps PostgreSQL numeric to a Decimal
        -- object, which would survive the numeric-only assertion below as an
        -- object and then serialise to something the monitor cannot compare.
        --
        -- The two CTEs give the classification a single source of truth: one
        -- row per distinct normalized address, assigned exactly one bucket by
        -- precedence. That is what makes the three category counts a true
        -- partition rather than overlapping tags.
        WITH distinct_addresses AS (
          SELECT DISTINCT lower(btrim(u.email)) AS addr
          FROM memberships m
          JOIN app_users u ON u.id = m.user_id
          WHERE m.role = 'owner' AND u.email IS NOT NULL AND btrim(u.email) <> ''
        ),
        classified AS (
          SELECT
            addr,
            CASE
              WHEN split_part(addr, '@', 2) IN ('bp.test', 'bookpitch.dev', 'isolation.dev')
                THEN 'fixture'
              WHEN split_part(addr, '@', 2) ~ '\\.(test|invalid|example|localhost)$'
                THEN 'reserved'
              ELSE 'other'
            END AS bucket
          FROM distinct_addresses
        )
        SELECT
          (
            SELECT (EXTRACT(EPOCH FROM (NOW() - max(created_at))) / 3600.0)::float8
            FROM email_outbox
            WHERE purpose = 'audit_digest'
          ) AS hours_since,
          -- Oldest organization that would actually receive a digest. Mirrors
          -- sendDigestToOwners() in lib/audit-digest.ts: an owner membership
          -- whose user has a non-null email. Counted as an age, never selected
          -- as an identifier.
          (
            SELECT (EXTRACT(EPOCH FROM (NOW() - min(o.created_at))) / 3600.0)::float8
            FROM organizations o
            WHERE EXISTS (
              SELECT 1
              FROM memberships m
              JOIN app_users u ON u.id = m.user_id
              WHERE m.organization_id = o.id
                AND m.role = 'owner'
                AND u.email IS NOT NULL
            )
          ) AS oldest_eligible_org_age_hours,
          -- Recipient COUNT only. Mirrors sendDigestToOwners(): owner
          -- memberships with a non-null email. No address is selected.
          (
            SELECT count(*)
            FROM memberships m
            JOIN app_users u ON u.id = m.user_id
            WHERE m.role = 'owner' AND u.email IS NOT NULL
          )::int AS eligible_owner_memberships,
          (
            SELECT count(DISTINCT o.id)
            FROM organizations o
            WHERE EXISTS (
              SELECT 1 FROM memberships m JOIN app_users u ON u.id = m.user_id
              WHERE m.organization_id = o.id AND m.role = 'owner' AND u.email IS NOT NULL
            )
          )::int AS eligible_organizations,
          (SELECT count(*) FROM distinct_addresses)::int
            AS distinct_normalized_recipient_addresses,
          -- One outbox row per (organization, address): exactly what
          -- sendDigestToOwners() writes, with the unique idempotency key
          -- collapsing duplicates inside an ISO week.
          (
            SELECT count(*) FROM (
              SELECT DISTINCT m.organization_id, lower(btrim(u.email)) AS addr
              FROM memberships m JOIN app_users u ON u.id = m.user_id
              WHERE m.role = 'owner' AND u.email IS NOT NULL AND btrim(u.email) <> ''
            ) pairs
          )::int AS expected_digest_messages_per_run,
          -- Mutually exclusive by precedence, so the three sum exactly to
          -- distinct_normalized_recipient_addresses.
          (SELECT count(*) FROM classified WHERE bucket = 'fixture')::int
            AS known_fixture_domain,
          (SELECT count(*) FROM classified WHERE bucket = 'reserved')::int
            AS reserved_tld_non_fixture,
          (SELECT count(*) FROM classified WHERE bucket = 'other')::int
            AS other_unclassified,
          -- Second pass over the 'other' bucket only.
          (
            SELECT count(*) FROM classified
            WHERE bucket = 'other' AND split_part(addr, '@', 2) = 'bookpitch.ge'
          )::int AS other_at_operator_domain,
          (
            SELECT count(DISTINCT split_part(addr, '@', 2))
            FROM classified WHERE bucket = 'other'
          )::int AS other_distinct_domains,
          (
            SELECT count(*)
            FROM organizations o
            WHERE EXISTS (
              SELECT 1 FROM memberships m JOIN app_users u ON u.id = m.user_id
              WHERE m.organization_id = o.id AND m.role = 'owner' AND u.email IS NOT NULL
            )
            AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.organization_id = o.id)
          )::int AS eligible_organizations_with_no_customers
      `,

    // P15-010: counts only. No encrypted value, address or identifier is
    // selected — the question is "does any ciphertext exist", nothing more.
    unsafePrismaAdmin.$queryRaw<
      Array<{ customer_fields: bigint; outbox_rows: bigint; mfa_secrets: bigint }>
    >`
        SELECT
          (
            SELECT count(*) FROM customers
            WHERE allergies IS NOT NULL OR clinical_notes IS NOT NULL
          ) AS customer_fields,
          (
            SELECT count(*) FROM email_outbox
            WHERE to_address_encrypted OR body_encrypted
          ) AS outbox_rows,
          (
            SELECT count(*) FROM app_users
            WHERE mfa_totp IS NOT NULL OR mfa_totp_pending IS NOT NULL
          ) AS mfa_secrets
      `,

    unsafePrismaAdmin.$queryRaw<Array<{ months_ahead: bigint; default_rows: bigint }>>`

        SELECT
          (
            SELECT count(*)
            FROM pg_inherits i
            JOIN pg_class child ON child.oid = i.inhrelid
            JOIN pg_class parent ON parent.oid = i.inhparent
            JOIN pg_namespace n ON n.oid = parent.relnamespace
            WHERE n.nspname = 'public'
              AND parent.relname = 'audit_log'
              AND child.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}$'
              AND child.relname > 'audit_log_' || to_char(NOW(), 'YYYY_MM')
          ) AS months_ahead,
          (SELECT count(*) FROM audit_log_default) AS default_rows
      `,
    // Heartbeats, aged against the DATABASE clock for the same reason as
    // every other age here: a serverless instance with a skewed clock must
    // not be able to make a dead job look alive.
    unsafePrismaAdmin.$queryRaw<
      Array<{
        job: string;
        minutes_ago: number | null;
        last_units: number;
        last_outcome: string;
        last_expected_units: number | null;
        last_failed_units: number | null;
        attempt_minutes_ago: number | null;
        success_at_epoch_ms: number | null;
      }>
    >`
        SELECT job,
               EXTRACT(EPOCH FROM (NOW() - last_succeeded_at))::float / 60 AS minutes_ago,
               -- The ABSOLUTE instant, as the database recorded it. The soak
               -- used to reconstruct this by subtracting minutes_ago from the
               -- GitHub runner's clock, which mixes PostgreSQL's NOW() with the
               -- runner's on the one comparison that decides whether the
               -- nightly sweep landed inside the window. Milliseconds, because
               -- this response is numeric-only by construction.
               -- (No backticks in this comment: it lives inside a tagged
               --  template literal, and a backtick would terminate it.)
               (EXTRACT(EPOCH FROM last_succeeded_at) * 1000)::float8 AS success_at_epoch_ms,
               last_units,
               last_outcome,
               last_expected_units,
               last_failed_units,
               EXTRACT(EPOCH FROM (NOW() - last_attempted_at))::float / 60 AS attempt_minutes_ago
          FROM cron_heartbeat
      `.catch((err: unknown) => {
      // Tolerates the table not existing, and NOTHING else. Vercel builds
      // the merge commit and migrate.yml applies the migration from the same
      // push; they race, and Vercel usually wins. Without this the whole ops
      // endpoint 500s for the minute or two between them, the monitor's ops
      // probe fails, and every ops-derived check goes UNOBSERVABLE for no
      // reason. An absent table yields no rows, which the monitor already
      // reads as "this deployment predates the metric" rather than a fault.
      //
      if (isUndefinedTableError(err)) return [];
      throw err;
    }),
    // Reminders that can never be sent: the appointment has already started and
    // no message_log row was ever created for it. Bounded to the recent past so
    // the count is about the current failure, not all history.
    unsafePrismaAdmin.$queryRaw<Array<{ unreminded: bigint }>>`
        SELECT count(*) AS unreminded
          FROM appointments a
          JOIN organizations o ON o.id = a.organization_id
         WHERE a.starts_at < NOW()
           AND a.starts_at > NOW() - interval '48 hours'
           -- Cancelled appointments were never owed a reminder. COMPLETED ones
           -- WERE: the appointment happened, and the customer should have been
           -- reminded beforehand. Excluding them hid exactly the cases where a
           -- missed reminder had already cost something.
           AND a.status <> 'cancelled'
           -- Was a reminder ever OWED? The clause here used to be
           --   a.created_at < a.starts_at - reminder_lead_hours
           -- which does not describe what the runtime does. runReminderTick()
           -- selects starts_at IN [now, now + lead] and puts NO condition on
           -- created_at at all, so an appointment booked 8 hours ahead under a
           -- 24-hour lead is inside the window the moment it exists and every
           -- tick from then on attempts it. The metric excluded exactly that
           -- population — every same-day booking — so the runtime could try,
           -- fail, and leave the customer unreminded while the one signal that
           -- was supposed to be un-fool-able reported zero.
           --
           -- Two ways to be owed one, and the first needs no inference:
           AND (
             -- The runtime demonstrably reached it. Any message_log row is
             -- proof a tick attempted this appointment, whenever it was booked.
             EXISTS (SELECT 1 FROM message_log m2 WHERE m2.appointment_id = a.id)
             -- Or it was never attempted, but existed long enough that a
             -- scheduled tick should have run in between. Bounded by the same
             -- tolerance the heartbeat check uses for reminders, which is the
             -- measured worst-case GitHub delivery gap plus margin (R-08) —
             -- so a booking made inside that gap is not called a miss, and the
             -- metric does not sit permanently non-zero for a clinic taking
             -- same-day bookings.
             OR a.starts_at - a.created_at >
                  make_interval(mins => ${OWED_MIN_LEAD_MINUTES}::int)
           )
           -- Only GENUINELY delivered states count as a reminder.
           --
           -- The 'queued' state used to be included here, and it is written
           -- BEFORE the provider call. A crash in between therefore produced a
           -- reminder that was never sent, could never be retried (the stale
           -- row deduped every later attempt), and was invisible to this
           -- metric — silent from all three directions at once.
           --
           -- Per channel, not per appointment: one successful email must not
           -- hide a failed SMS. An appointment is counted as missed when ANY
           -- required channel has no delivery.
           AND EXISTS (
             SELECT 1 FROM unnest(ARRAY['sms', 'email']::message_channel[]) AS ch(channel)
              WHERE NOT EXISTS (
                SELECT 1 FROM message_log m
                 WHERE m.appointment_id = a.id
                   AND m.channel = ch.channel
                   AND m.state IN ('sent', 'delivered')
              )
           )
      `,
  ]);

  const o = outboxRows[0] ?? {};
  const h = housekeepingRows[0] ?? {};
  const r = retentionRows[0] ?? {};
  const d = digestRows[0] ?? {};
  const c = ciphertextRows[0] ?? {};
  const p = partitionRows[0] ?? {};

  return {
    outbox: {
      pending: num((o as Record<string, unknown>).pending),
      processing: num((o as Record<string, unknown>).processing),
      dead: num((o as Record<string, unknown>).dead),
      staleClaims: num((o as Record<string, unknown>).stale_claims),
      oldestPendingAgeSeconds: numOrNull((o as Record<string, unknown>).oldest_pending_age_seconds),
      deadLast24h: num((o as Record<string, unknown>).dead_last_24h),
      deadWithExhaustedRetries: num((o as Record<string, unknown>).dead_exhausted),
    },
    housekeeping: {
      overdueRateLimitRows: num((h as Record<string, unknown>).overdue_rate_limit),
      overdueExpiredTokens: num((h as Record<string, unknown>).overdue_tokens),
      overdueReauthGrants: num((h as Record<string, unknown>).overdue_reauth),
    },
    retention: {
      overdueCustomers: num((r as Record<string, unknown>).overdue_customers),
    },
    auditDigest: {
      hoursSinceLastQueued: numOrNull((d as Record<string, unknown>).hours_since),
      oldestEligibleOrgAgeHours: numOrNull(
        (d as Record<string, unknown>).oldest_eligible_org_age_hours,
      ),
      eligibleOwnerMemberships: num((d as Record<string, unknown>).eligible_owner_memberships),
      eligibleOrganizations: num((d as Record<string, unknown>).eligible_organizations),
      distinctNormalizedRecipientAddresses: num(
        (d as Record<string, unknown>).distinct_normalized_recipient_addresses,
      ),
      expectedDigestMessagesPerRun: num(
        (d as Record<string, unknown>).expected_digest_messages_per_run,
      ),
      deliveryEnabled: isAuditDigestDeliveryEnabled() ? 1 : 0,
      deliveryConfigMalformed: auditDigestDeliveryMode() === 'disabled_malformed' ? 1 : 0,
      knownFixtureDomain: num((d as Record<string, unknown>).known_fixture_domain),
      reservedTldNonFixture: num((d as Record<string, unknown>).reserved_tld_non_fixture),
      otherUnclassified: num((d as Record<string, unknown>).other_unclassified),
      otherAtOperatorDomain: num((d as Record<string, unknown>).other_at_operator_domain),
      otherDistinctDomains: num((d as Record<string, unknown>).other_distinct_domains),
      eligibleOrganizationsWithNoCustomers: num(
        (d as Record<string, unknown>).eligible_organizations_with_no_customers,
      ),
    },
    ciphertext: (() => {
      const customerFields = num((c as Record<string, unknown>).customer_fields);
      const outboxRows2 = num((c as Record<string, unknown>).outbox_rows);
      const mfaSecrets = num((c as Record<string, unknown>).mfa_secrets);
      return {
        customerFields,
        outboxRows: outboxRows2,
        mfaSecrets,
        total: customerFields + outboxRows2 + mfaSecrets,
      };
    })(),
    partitions: {
      monthsAhead: num((p as Record<string, unknown>).months_ahead),
      defaultPartitionRows: num((p as Record<string, unknown>).default_rows),
    },
    cronHeartbeat: (() => {
      const by = new Map((heartbeatRows ?? []).map((row) => [row.job, row] as const));
      const ago = (job: string) => numOrNull(by.get(job)?.minutes_ago);
      // Numeric so the response stays numbers-and-null only.
      const outcomeCode = (o: string | undefined) =>
        o === 'success' ? 1 : o === 'partial' ? 0 : o === 'failure' ? -1 : null;
      const r = by.get('reminders');
      return {
        remindersMinutesAgo: ago('reminders'),
        housekeepingMinutesAgo: ago('housekeeping'),
        retentionMinutesAgo: ago('retention'),
        auditDigestMinutesAgo: ago('audit-digest'),
        remindersLastUnits: numOrNull(r?.last_units),
        remindersLastOutcome: outcomeCode(r?.last_outcome),
        remindersExpectedUnits: numOrNull(r?.last_expected_units),
        remindersFailedUnits: numOrNull(r?.last_failed_units),
        remindersAttemptMinutesAgo: numOrNull(r?.attempt_minutes_ago),
        jobsNotSucceeding: (heartbeatRows ?? []).filter(
          (row) => row.last_outcome !== 'success' && row.last_outcome !== 'unknown',
        ).length,
        jobs: Object.fromEntries(
          HEARTBEAT_JOBS.map((job) => {
            const row = by.get(job);
            return [
              HEARTBEAT_METRIC_KEY[job],
              {
                present: row ? 1 : 0,
                outcome: outcomeCode(row?.last_outcome),
                successMinutesAgo: numOrNull(row?.minutes_ago),
                successAtEpochMs: numOrNull(row?.success_at_epoch_ms),
                attemptMinutesAgo: numOrNull(row?.attempt_minutes_ago),
                expectedUnits: numOrNull(row?.last_expected_units),
                processedUnits: numOrNull(row?.last_units),
                failedUnits: numOrNull(row?.last_failed_units),
                maxAgeMinutes: HEARTBEAT_MAX_AGE_MINUTES[job],
              },
            ];
          }),
        ),
        unremindedStartedAppointments: num(unremindedRows?.[0]?.unreminded),
      };
    })(),
    config: collectConfigMetrics(),
  };
}

/**
 * Every leaf of OpsMetrics must be a number or null. This is enforced at
 * runtime, not just in the type system, because the response is shipped to a
 * CI log where a stray string would be a disclosure. A violation is a bug
 * loud enough to fail the request rather than something to log and continue.
 */
export function assertMetricsAreNumericOnly(metrics: unknown, path = 'metrics'): void {
  if (metrics === null) return;
  if (typeof metrics === 'number') {
    if (!Number.isFinite(metrics)) {
      throw new Error(`ops-metrics: ${path} is not a finite number`);
    }
    return;
  }
  if (typeof metrics === 'object') {
    for (const [key, value] of Object.entries(metrics as Record<string, unknown>)) {
      assertMetricsAreNumericOnly(value, `${path}.${key}`);
    }
    return;
  }
  throw new Error(
    `ops-metrics: ${path} is a ${typeof metrics}; only numbers and null may be exposed`,
  );
}
