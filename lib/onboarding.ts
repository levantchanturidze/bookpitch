import { randomBytes, createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import { withoutRls } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import {
  deliverNow,
  enqueueEmail,
  supersedePendingEmails,
  VERIFICATION_EMAIL_PURPOSE,
  verificationEmailKey,
} from '@/lib/messaging/outbox';
import { log } from '@/lib/logger';
import { encryptField, hashEmailForIndex } from '@/lib/crypto';
import { isE2ELoopbackRuntime } from '@/lib/auth/e2e-runtime';

// -----------------------------------------------------------------------------
// Self-service org onboarding — two-phase: pending → activated.
//
// Phase 1 (createPendingRegistration):
//   Validates input, hashes password, stores a PendingRegistration row, and
//   sends a verification email with a one-time token. The org and user are NOT
//   created yet. An unverified address cannot operate as a tenant.
//
// Phase 2 (activatePendingRegistration):
//   Called from GET /api/onboard/verify?token=<raw>.
//   Atomically deletes the pending row (single-use) and transactionally creates
//   the org, user, membership, location, and sets ownerUserId. If the pending
//   row is expired or already consumed, the token is rejected.
//
// Security invariants:
//   • Raw token never stored — only SHA-256(token) is in the DB.
//   • Token is 32 cryptographically random bytes (256-bit entropy).
//   • Pending row is deleted atomically on activation — replay is impossible.
//   • A second signup for the same email while a pending row exists replaces
//     the pending row (resend semantics) rather than failing with "already registered".
//   • Actual org/user creation happens only after the email is verified.
//   • ownerUserId is always set atomically in the same transaction.
// -----------------------------------------------------------------------------

export type OnboardInput = {
  email: string;
  password: string;
  fullName: string;
  orgName: string;
  locationName?: string;
  locationType?: 'clinic' | 'salon';
  tokenTtlMs?: number;
};

export type OnboardInputDirect = Omit<OnboardInput, 'tokenTtlMs'>;

export type OnboardResult = {
  userId: string;
  organizationId: string;
  locationId: string;
};

function hashToken(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Returns the canonical application origin for building email verification URLs.
 * In production (NODE_ENV=production), rejects HTTP and localhost to prevent
 * token links pointing to an unencrypted or local origin.
 */
function resolveAppUrl(): string {
  const raw = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? 'http://localhost:3000';
  // P17-009: `next start` sets NODE_ENV=production, so these checks fire
  // during any local end-to-end run and signup answers 500 before reaching the
  // logic under test. The relaxation is gated on the same one-way condition as
  // the Turnstile credential — a >=32-char E2E_TURNSTILE_BYPASS_TOKEN AND an
  // APP_URL on loopback — so it grants nothing that condition has not already
  // asserted, and production's https://bookpitch.ge fails it outright.
  //
  // Deliberately not a NODE_ENV escape: NODE_ENV IS production here, which is
  // exactly the configuration worth testing.
  if (process.env.NODE_ENV === 'production' && !isE2ELoopbackRuntime()) {
    if (!raw.startsWith('https://')) {
      throw new Error('APP_URL must use HTTPS in production');
    }
    try {
      const u = new URL(raw);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
        throw new Error('APP_URL must not be localhost in production');
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('APP_URL')) throw e;
      throw new Error(`APP_URL is not a valid URL: ${raw}`);
    }
  }
  return raw.replace(/\/$/, '');
}

/**
 * Validate input and create/replace a PendingRegistration. Sends a
 * verification email. Does NOT create the org or user yet.
 *
 * Idempotent on duplicate email: replaces an existing pending row so the
 * user can resend the verification link. (An already-activated email returns
 * a generic success — enumeration safe.)
 */
export async function createPendingRegistration(input: OnboardInput): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const orgName = input.orgName.trim();
  const locationName = (input.locationName ?? 'Main location').trim();
  const locationType = input.locationType ?? 'clinic';
  const tokenTtlMs = input.tokenTtlMs ?? 24 * 60 * 60 * 1000;

  if (!email || !email.includes('@') || email.length > 254) {
    throw new InvalidInputError('email is invalid');
  }
  if (!input.password || input.password.length < 8) {
    throw new InvalidInputError('password must be at least 8 characters');
  }
  if (!fullName) throw new InvalidInputError('fullName is required');
  if (!orgName) throw new InvalidInputError('orgName is required');
  if (locationType !== 'clinic' && locationType !== 'salon') {
    throw new InvalidInputError('locationType must be clinic or salon');
  }

  // Fail silently (still return generic success) if the email is already
  // an active user — caller gets the same 202 response either way.
  const existing = await withoutRls((tx) =>
    tx.appUser.findUnique({ where: { email }, select: { id: true } }),
  );
  if (existing) {
    // Return without error. The caller receives the same 202 response.
    // No email is sent (re-sending to an existing account would be confusing
    // and could facilitate phishing). The UI should say "if this address is
    // new, check your email."
    return;
  }

  const passwordHash = await hash(input.password);
  const rawToken = randomBytes(32);
  const tokenHash = hashToken(rawToken);

  // Upsert: replace any existing pending row for this email (resend semantics).
  // appUrl is validated by resolveAppUrl() — throws in production if HTTP or localhost.
  // expires_at is computed by the DB (now() + interval) so clock skew between
  // the application server and the database cannot cause tokens to arrive
  // pre-expired. tokenTtlMs is a small integer we own — not user-supplied.
  //
  // The outbox row is inserted in the SAME transaction as the pending
  // registration row to ensure durable delivery intent. The body is
  // AES-256-GCM encrypted so the plaintext token never rests in the DB.
  const appUrl = resolveAppUrl();
  const verifyUrl = `${appUrl}/api/onboard/verify?token=${rawToken.toString('hex')}`;
  const emailBody = `Thanks for signing up!\n\nClick the link below to verify your email and activate your account.\nThis link expires in 24 hours.\n\n${verifyUrl}\n\nIf you didn't sign up, you can ignore this email.`;
  const encryptedBody = encryptField(emailBody) ?? emailBody;
  // No PII in the key (a digest of the address), and the token-hash prefix
  // that lets the outbox tell a current link from a stale one.
  const idempotencyKey = verificationEmailKey('verify', email, tokenHash);
  // HMAC-SHA256 of the lowercase address — stored in to_address_hash for indexed
  // lookup. Keyed by EMAIL_PRIVACY_HMAC_KEY to resist rainbow-table attacks.
  const toAddressHash = hashEmailForIndex(email);
  const encryptedToAddress = encryptField(email) ?? email;
  const toAddressEncrypted = encryptedToAddress !== email;

  await withoutRls(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO pending_registrations
        (email, password_hash, full_name, org_name, location_name, location_type, token_hash, expires_at)
      VALUES
        (${email}, ${passwordHash}, ${fullName}, ${orgName},
         ${locationName}, ${locationType}, ${tokenHash},
         now() + (${tokenTtlMs} * interval '1 millisecond'))
      ON CONFLICT (email) DO UPDATE SET
        password_hash  = EXCLUDED.password_hash,
        full_name      = EXCLUDED.full_name,
        org_name       = EXCLUDED.org_name,
        location_name  = EXCLUDED.location_name,
        location_type  = EXCLUDED.location_type,
        token_hash     = EXCLUDED.token_hash,
        expires_at     = now() + (${tokenTtlMs} * interval '1 millisecond')
    `;
    // The token above replaced any earlier one, so every queued verification
    // email for this address now carries a dead link: withdraw them, in the
    // same transaction that issues the replacement. Same helper and same
    // terminal state as the resend path and password reset. (A legacy
    // plaintext-address row is not matched by its HMAC here, but its token is
    // not current either, so the delivery-time check withdraws it.)
    await supersedePendingEmails(tx, VERIFICATION_EMAIL_PURPOSE, email);
    // Insert new outbox row via raw SQL — idempotency_key has a partial unique index
    // (WHERE idempotency_key IS NOT NULL) so the ON CONFLICT clause must include
    // the same predicate to match the index. Prisma's upsert can't use partial indexes.
    await tx.$executeRaw`
      INSERT INTO email_outbox
        (idempotency_key, to_address, to_address_encrypted, to_address_hash, subject, body, body_encrypted, purpose)
      VALUES
        (${idempotencyKey}, ${encryptedToAddress}, ${toAddressEncrypted}, ${toAddressHash},
         'Verify your Bookpitch account', ${encryptedBody}, true, 'onboard.verify')
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
        body               = EXCLUDED.body,
        body_encrypted     = true,
        to_address         = EXCLUDED.to_address,
        to_address_encrypted = EXCLUDED.to_address_encrypted,
        to_address_hash    = EXCLUDED.to_address_hash,
        status             = 'pending',
        next_attempt_at    = now(),
        attempts           = 0,
        claim_owner        = NULL,
        claim_expires_at   = NULL,
        claimed_at         = NULL
    `;
  });

  // Deliver NOW, best-effort, after the row has committed — exactly as
  // invitations, password resets and the resend path already do.
  //
  // This used to stop at the INSERT, so the verification email waited for the
  // next housekeeping drain (`3 * * * *`, delivered by GitHub's scheduler). On
  // 2026-09-30 that schedule went seven hours undelivered (06:24Z to 13:26Z),
  // and a production sign-up that afternoon received nothing — while
  // invitations sent from the same deployment arrived within seconds. Pressing
  // "Resend" straight away did not help either: inside its five-minute
  // cooldown it correctly does nothing.
  //
  // deliverNow() never throws. If the provider refuses, the row goes back to
  // `pending` and the drain retries it with backoff — the outbox row written
  // above is still the durable record, this only stops it waiting.
  await deliverNow(idempotencyKey, 'onboard.verify');

  log.info('onboard.pending_created', { orgName });
}

/**
 * Direct (non-pending) onboarding — bypasses email verification.
 * Use ONLY in tests and internal tooling (e.g. seeding). The production
 * onboarding path goes through createPendingRegistration → email → activate.
 */
export async function onboardOrg(input: OnboardInputDirect): Promise<OnboardResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const orgName = input.orgName.trim();
  const locationName = (input.locationName ?? 'Main location').trim();
  const locationType = input.locationType ?? 'clinic';

  if (!email || !email.includes('@') || email.length > 254) {
    throw new InvalidInputError('email is invalid');
  }
  if (!input.password || input.password.length < 8) {
    throw new InvalidInputError('password must be at least 8 characters');
  }
  if (!fullName) throw new InvalidInputError('fullName is required');
  if (!orgName) throw new InvalidInputError('orgName is required');
  if (locationType !== 'clinic' && locationType !== 'salon') {
    throw new InvalidInputError('locationType must be clinic or salon');
  }

  const existing = await withoutRls((tx) =>
    tx.appUser.findUnique({ where: { email }, select: { id: true } }),
  );
  if (existing) throw new InvalidInputError('email already registered');

  const passwordHash = await hash(input.password);

  return withoutRls(async (tx) => {
    const org = await tx.organization.create({ data: { name: orgName } });
    const location = await tx.location.create({
      data: { organizationId: org.id, type: locationType, name: locationName },
    });
    const user = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: email,
        email,
        fullName,
        name: fullName,
        passwordHash,
        emailVerified: new Date(), // direct path — treated as verified
      },
    });
    const ownerRole = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: user.id, role: 'owner', roleId: ownerRole.id },
    });
    await tx.organization.update({
      where: { id: org.id },
      data: { ownerUserId: user.id },
    });
    log.info('onboard.ok', { organizationId: org.id, userId: user.id });
    return { userId: user.id, organizationId: org.id, locationId: location.id };
  });
}

/**
 * Activate a pending registration. Called from the verification endpoint.
 *
 * Atomically:
 *   1. Deletes the pending_registrations row (single-use — prevents replay).
 *   2. Creates the org, user, membership, and location in a transaction.
 *   3. Sets ownerUserId on the org in the same transaction.
 *
 * Returns the identifiers so the caller can direct the user to sign in.
 * Throws InvalidInputError for expired or unknown tokens.
 */
export async function activatePendingRegistration(rawTokenHex: string): Promise<OnboardResult> {
  if (!rawTokenHex || rawTokenHex.length !== 64 || !/^[0-9a-f]+$/i.test(rawTokenHex)) {
    throw new InvalidInputError('invalid verification token');
  }

  const tokenHash = hashToken(Buffer.from(rawTokenHex, 'hex'));

  // Single transaction: DELETE the pending row AND create org/user/membership.
  // Keeping both operations in one transaction means that if entity creation
  // fails, the DELETE is rolled back and the token remains usable on retry.
  // Previously these were two separate withoutRls calls — a failure between
  // them would consume the token without creating the account.
  return withoutRls(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        email: string;
        password_hash: string;
        full_name: string;
        org_name: string;
        location_name: string;
        location_type: string;
      }>
    >`
      DELETE FROM pending_registrations
      WHERE token_hash = ${tokenHash}
        AND expires_at > now()
      RETURNING
        email, password_hash, full_name, org_name, location_name, location_type
    `;

    if (rows.length === 0) {
      throw new InvalidInputError('verification link is invalid or has expired');
    }

    const pending = rows[0];
    const email = pending.email;
    const fullName = pending.full_name;
    const orgName = pending.org_name;
    const locationName = pending.location_name;
    const locationType = pending.location_type as 'clinic' | 'salon';
    const passwordHash = pending.password_hash;

    // Guard: don't create a duplicate app_user if a concurrent activation ran first.
    const existingUser = await tx.appUser.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      // Activation already completed by a concurrent request. Return the
      // existing identifiers so the caller can sign in.
      const org = await tx.organization.findFirst({
        where: { ownerUserId: existingUser.id },
        select: { id: true, locations: { select: { id: true }, take: 1 } },
      });
      if (!org) throw new InvalidInputError('account already activated');
      return {
        userId: existingUser.id,
        organizationId: org.id,
        locationId: org.locations[0]?.id ?? '',
      };
    }

    const org = await tx.organization.create({ data: { name: orgName } });
    const location = await tx.location.create({
      data: { organizationId: org.id, type: locationType, name: locationName },
    });

    let user;
    try {
      user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: email,
          email,
          fullName,
          name: fullName,
          passwordHash,
          emailVerified: new Date(), // email is verified by the token flow
        },
      });
    } catch (e) {
      // P2002 on email unique: two concurrent activations raced. The other
      // transaction won — treat as already-activated.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await tx.appUser.findUnique({ where: { email }, select: { id: true } });
        if (existing) throw new InvalidInputError('account already activated');
      }
      throw e;
    }

    const ownerRole = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: user.id, role: 'owner', roleId: ownerRole.id },
    });
    // Invariant: org always has an ownerUserId set in the same transaction.
    await tx.organization.update({
      where: { id: org.id },
      data: { ownerUserId: user.id },
    });

    log.info('onboard.activated', { organizationId: org.id });
    return { userId: user.id, organizationId: org.id, locationId: location.id };
  });
}

// ── Resend verification email ─────────────────────────────────────────────────

const RESEND_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESEND_COOLDOWN_MS = 5 * 60 * 1000; // minimum 5 min between resends

/**
 * Rotate the verification token for a pending registration and queue a new
 * verification email via the outbox.
 *
 * Enumeration-safe: returns without error for unknown emails, already-activated
 * accounts, and cooldown violations. The caller always sees the same 202.
 *
 * Cooldown is enforced at the DB level: the UPDATE only succeeds when the
 * existing token's expires_at is far enough in the past to imply the cooldown
 * has elapsed (expires_at < now() + (TTL - cooldown)).
 *
 * The raw token is never emitted in structured log fields. It appears only in
 * the email body written to email_outbox.body (the encrypted transport channel).
 */
export async function resendPendingRegistration(email: string): Promise<void> {
  // Fail silently if already an active user.
  const existing = await withoutRls((tx) =>
    tx.appUser.findUnique({ where: { email }, select: { id: true } }),
  );
  if (existing) return;

  const rawToken = randomBytes(32);
  const tokenHash = hashToken(rawToken);
  const appUrl = resolveAppUrl();
  const verifyUrl = `${appUrl}/api/onboard/verify?token=${rawToken.toString('hex')}`;

  const ttlMs = RESEND_TOKEN_TTL_MS;
  const cooldownMs = RESEND_COOLDOWN_MS;

  // ONE transaction: rotate the token, withdraw every queued email carrying an
  // earlier one, and queue the email carrying the new one. Nothing about the
  // old link changes until the new link AND its delivery intent exist: if any
  // step fails, all of it rolls back and the previous email and token stand.
  //
  // The withdrawal is what this used to be missing. The rotation killed the
  // previous token, but a previous email still queued — the sign-up mail whose
  // first send failed and is waiting for a retry, say — was left pending, and
  // the next drain delivered it: a verification email whose link no longer
  // worked, arriving beside the one that did.
  //
  // WHERE clause enforces cooldown: update only if the old token's expiry implies
  // it was issued more than cooldownMs ago (expires_at < now() + TTL - cooldown).
  // Two concurrent resends serialise on this row; the second sees the first's
  // new expiry and changes nothing.
  type PendingRow = { email: string; full_name: string };
  const rotated = await withoutRls(async (tx) => {
    const rows = await tx.$queryRaw<PendingRow[]>`
      UPDATE pending_registrations
      SET token_hash = ${tokenHash},
          expires_at = now() + (${ttlMs} * interval '1 millisecond')
      WHERE email = ${email}
        AND expires_at < now() + (${ttlMs - cooldownMs} * interval '1 millisecond')
      RETURNING email, full_name
    `;

    if (rows.length === 0) return null; // not registered, cooldown, or already expired+rotated

    await supersedePendingEmails(tx, VERIFICATION_EMAIL_PURPOSE, email);

    const idempotencyKey = verificationEmailKey('resend', email, tokenHash);
    await enqueueEmail(tx, {
      idempotencyKey,
      to: email,
      subject: 'Verify your Bookpitch account',
      body:
        `Hi ${rows[0].full_name},\n\n` +
        `You requested a new verification link.\n\n` +
        `Click the link below to verify your email and activate your account.\n` +
        `This link expires in 24 hours.\n\n` +
        `${verifyUrl}\n\n` +
        `If you didn't request this, you can ignore this email.`,
      purpose: VERIFICATION_EMAIL_PURPOSE,
    });

    return { idempotencyKey };
  });

  if (rotated === null) return; // enumeration-safe

  // Deliver now, best-effort, after the commit — the same path sign-up,
  // invitations and password resets take. It never throws; a provider failure
  // returns the row to `pending` for the drain to retry with backoff (the hand-
  // rolled send this replaces left it `processing` until its claim expired),
  // and it re-checks that the link is still current immediately before sending.
  await deliverNow(rotated.idempotencyKey, VERIFICATION_EMAIL_PURPOSE);

  log.info('onboard.resend.ok', {}); // deliberately empty — no email or token in log
}
