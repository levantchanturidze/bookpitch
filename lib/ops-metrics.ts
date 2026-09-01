// Group C: operational probe — no session, cross-tenant counts only. The
// no-restricted-imports rule that used to need a disable here no longer
// reports on this import, and an unused disable is itself a lint warning.
import { unsafePrismaAdmin } from '@/lib/db';
import { auditDigestDeliveryMode, isAuditDigestDeliveryEnabled } from '@/lib/audit-digest';

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
};

export type OpsMetrics = {
  outbox: OutboxMetrics;
  housekeeping: HousekeepingMetrics;
  retention: RetentionMetrics;
  auditDigest: AuditDigestMetrics;
  ciphertext: CiphertextMetrics;
  partitions: PartitionMetrics;
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

export const REQUIRED_EMAIL_ENV = ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_FROM'] as const;

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
export function missingEnv(names: readonly string[]): string[] {
  return names.filter((name) => !(process.env[name] ?? '').trim());
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
export const SECURITY_ENV_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
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

  // F16-001/002: a provider set to "mock" in production is set-but-unusable in
  // the most literal sense — the adapter returns a synthetic success without
  // contacting anyone. getGateway() and the messaging resolvers already refuse
  // it at the call site, but that only fires when something tries to pay or
  // send. This makes the same fault visible to the monitor beforehand, rather
  // than at the first real payment.
  //
  // Absence is not checked here (invalidEnv() skips unset variables, and the
  // resolvers throw); this is strictly the "configured wrong" case.
  PAYMENT_GATEWAY: (v) => isRealProvider(v, ['bog', 'bog_ipay', 'tbc', 'tbc_ecommerce']),
  EMAIL_PROVIDER: (v) => isRealProvider(v, ['postmark', 'resend']),
  SMS_PROVIDER: (v) => isRealProvider(v, ['smsoffice']),
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

export function collectConfigMetrics(): ConfigMetrics {
  return {
    missingSignupEnv: missingEnv(REQUIRED_SIGNUP_ENV).length,
    missingEmailEnv: missingEnv(REQUIRED_EMAIL_ENV).length,
    missingSecurityEnv: missingEnv(REQUIRED_SECURITY_ENV).length,
    missingObservabilityEnv: missingEnv(REQUIRED_OBSERVABILITY_ENV).length,
    invalidSecurityEnv: invalidEnv().length,
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

export async function collectOpsMetrics(): Promise<OpsMetrics> {
  // One statement per concern, all using the DB clock. Node's clock is not
  // authoritative for anything time-based in this project (see CLAUDE.md and
  // the reauth-expiry memory): a skewed runner must not be able to invent a
  // healthy-looking age.
  const [outboxRows, housekeepingRows, retentionRows, digestRows, ciphertextRows, partitionRows] =
    await Promise.all([
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
        WHERE c.updated_at < NOW() - (o.customer_retention_years * interval '1 year')
          AND c.name NOT LIKE 'Redacted Customer #%'
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.customer_id = c.id
              AND a.starts_at >= NOW() - (o.customer_retention_years * interval '1 year')
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
