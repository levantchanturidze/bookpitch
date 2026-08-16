import { randomBytes, createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import { withoutRls, unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { getEmailProvider } from '@/lib/messaging';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { encryptField, decryptField, hashEmailForIndex } from '@/lib/crypto';

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
  if (process.env.NODE_ENV === 'production') {
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
  // Use a SHA-256 digest of the email so the idempotency key contains no PII.
  const emailHash = createHash('sha256').update(email).digest('hex').slice(0, 16);
  const idempotencyKey = `onboard_verify:${emailHash}:${tokenHash.slice(0, 16)}`;
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
    // Cancel any previously pending verification emails for this address. The
    // cancel query matches on to_address_hash (for encrypted rows) OR the
    // plaintext to_address (for legacy plaintext rows), so both are covered.
    await tx.$executeRaw`
      UPDATE email_outbox
      SET status = 'cancelled'
      WHERE purpose = 'onboard.verify'
        AND (to_address_hash = ${toAddressHash} OR to_address = ${email})
        AND status = 'pending'
    `;
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

  // Atomically: rotate the token + write outbox intent.
  // WHERE clause enforces cooldown: update only if the old token's expiry implies
  // it was issued more than cooldownMs ago (expires_at < now() + TTL - cooldown).
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

    const rawBody =
      `Hi ${rows[0].full_name},\n\n` +
      `You requested a new verification link.\n\n` +
      `Click the link below to verify your email and activate your account.\n` +
      `This link expires in 24 hours.\n\n` +
      `${verifyUrl}\n\n` +
      `If you didn't request this, you can ignore this email.`;
    const encryptedOrRaw = encryptField(rawBody);
    const bodyEncrypted = encryptedOrRaw !== null;
    const encryptedBody = encryptedOrRaw ?? rawBody;
    const resendEmailHash = createHash('sha256').update(email).digest('hex').slice(0, 16);
    const idempotencyKey = `onboard_resend:${resendEmailHash}:${tokenHash.slice(0, 16)}`;
    const resendToAddressHash = hashEmailForIndex(email);
    const encryptedToAddress = encryptField(email) ?? email;
    const toAddressEncrypted = encryptedToAddress !== email;
    await tx.emailOutbox.create({
      data: {
        idempotencyKey,
        toAddress: encryptedToAddress,
        toAddressEncrypted,
        toAddressHash: resendToAddressHash,
        subject: 'Verify your Bookpitch account',
        body: encryptedBody,
        bodyEncrypted,
        purpose: 'onboard.verify',
      },
    });

    return { idempotencyKey, encryptedBody, bodyEncrypted };
  });

  if (rotated === null) return; // enumeration-safe

  // Immediate drain — best-effort, outside the DB transaction.
  try {
    type ClaimedRow = {
      id: string;
      to_address: string;
      to_address_encrypted: boolean;
      subject: string;
      body: string;
      body_encrypted: boolean;
    };
    const [claimed] = await unsafePrismaAdmin.$queryRaw<ClaimedRow[]>`
      UPDATE email_outbox
      SET status = 'processing',
          claim_owner = 'onboard_resend_immediate',
          claim_expires_at = now() + interval '120 seconds',
          claimed_at = now()
      WHERE idempotency_key = ${rotated.idempotencyKey} AND status = 'pending'
      RETURNING id, to_address, to_address_encrypted, subject, body, body_encrypted
    `;
    if (claimed) {
      const toAddress = claimed.to_address_encrypted
        ? (decryptField(claimed.to_address) ?? claimed.to_address)
        : claimed.to_address;
      const body = claimed.body_encrypted
        ? (decryptField(claimed.body) ?? claimed.body)
        : claimed.body;
      const provider = getEmailProvider();
      await provider.send(toAddress, claimed.subject, body);
      await unsafePrismaAdmin.$executeRaw`
        UPDATE email_outbox
        SET status = 'sent', sent_at = now(), claim_owner = NULL
        WHERE id = ${claimed.id}::uuid
      `;
    }
  } catch (err) {
    log.warn('onboard.resend.immediate_drain_failed', { err: sanitizeErrorMessage(err) });
  }

  log.info('onboard.resend.ok', {}); // deliberately empty — no email or token in log
}
