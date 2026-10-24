import { randomBytes, createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { enqueueEmail, supersedePendingEmails, deliverNow } from '@/lib/messaging/outbox';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Password reset flow.
//
// requestReset(email):
//   - Rate-limited by the caller.
//   - Always returns the same "if the address exists, we sent a link" shape
//     from the route — never leaks whether an account exists.
//   - Stores a HASH of the token (never the token itself) with a 1-hour
//     expiry in verification_tokens (identifier = email, token = sha256).
//   - Enqueues the RAW token's link on the durable email outbox (P17-002).
//
// consumeReset(rawToken, newPassword):
//   - Hashes rawToken, looks up the row, checks expiry.
//   - Rehashes password with argon2, updates AppUser, bumps sessionVersion.
//   - Deletes the reset row so it cannot be reused.
//   - The bumped sessionVersion invalidates ALL existing JWTs for the user
//     within ~5s (see auth.ts session() cache TTL).
// -----------------------------------------------------------------------------

const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Outbox category for reset mail. Used for superseding and for ops metrics. */
const PURPOSE = 'password_reset.link';

export type RequestResetInput = { email: string };

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function requestPasswordReset(input: RequestResetInput): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes('@')) {
    throw new InvalidInputError('email is required');
  }

  const user = await withoutRls((tx) =>
    tx.appUser.findUnique({ where: { email }, select: { id: true } }),
  );
  if (!user) {
    // Silently no-op — the route response is identical either way.
    log.info('password_reset.request.unknown_email');
    return;
  }

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);

  const origin = process.env.APP_URL ?? 'http://localhost:3000';
  const url = `${origin}/reset?token=${encodeURIComponent(rawToken)}`;
  // Keyed on the token hash: one queue row per issued token, so a retry
  // re-sends THIS link rather than minting another one.
  const idempotencyKey = `password_reset:${tokenHash.slice(0, 32)}`;

  await withoutRls(async (tx) => {
    // The expiry is the DATABASE's now plus the TTL, the clock consumeReset and
    // housekeeping judge it by. It used to be this process's Date.now(): an
    // instance whose clock ran behind honoured a link past its expiry.
    const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT transaction_timestamp() AS now`;
    const expires = new Date(now.getTime() + TOKEN_TTL_MS);
    // Drop any prior in-flight tokens for this email so only the newest is valid.
    await tx.verificationToken.deleteMany({ where: { identifier: email } });
    await tx.verificationToken.create({
      data: { identifier: email, token: tokenHash, expires },
    });
    // …and drop any queued mail carrying one of those now-dead links, so the
    // user cannot receive a link that this very request just invalidated.
    await supersedePendingEmails(tx, PURPOSE, email);
    // Same transaction as the token write: if the token does not commit, no
    // email is queued, and if the email cannot be queued, no token exists.
    await enqueueEmail(tx, {
      idempotencyKey,
      to: email,
      subject: 'Reset your Bookpitch password',
      body:
        `A password reset was requested for your account.\n\n` +
        `Open this link within the next hour to choose a new password:\n\n${url}\n\n` +
        `If you didn't request this, you can safely ignore the message.`,
      purpose: PURPOSE,
      // The link dies after TOKEN_TTL_MS. Retrying past that delivers a dead
      // link, so the budget is deliberately smaller than the outbox default.
      maxAttempts: 2,
    });
  });

  // Best-effort immediate send. If it fails the row stays queued and the
  // housekeeping drain retries with backoff; if it exhausts its attempts the
  // row goes to dead-letter, which lib/ops-metrics.ts counts and the
  // production monitor alarms on. Either way the mail is no longer lost.
  const delivered = await deliverNow(idempotencyKey, PURPOSE);
  log.info('password_reset.request.queued', { deliveredImmediately: delivered });
}

export type ConsumeResetInput = { token: string; newPassword: string };

export async function consumeReset(input: ConsumeResetInput): Promise<{ userId: string }> {
  const { token, newPassword } = input;
  if (typeof token !== 'string' || token.length < 20) {
    throw new InvalidInputError('token is required');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new InvalidInputError('password must be at least 8 characters');
  }

  const tokenHash = hashToken(token);
  // Expiry is judged by the database clock, the one the expiry was set by.
  // A cheap check first, so an invalid link never costs an argon2 hash.
  const live = await unsafePrismaAdmin.$queryRaw<Array<{ identifier: string }>>`
    SELECT identifier FROM verification_tokens
     WHERE token = ${tokenHash} AND expires > transaction_timestamp()`;
  if (live.length === 0) throw new InvalidInputError('invalid or expired token');

  // Hashed outside the transaction: argon2 is slow, and an interactive
  // transaction has a time limit.
  const passwordHash = await hash(newPassword);

  // Check-and-consume is one locked step. Two requests with the same link used
  // to both pass the check above; the loser then failed on deleting an already
  // deleted token, an unhandled error (a 500) rather than a refusal. Now the
  // second waits on the row lock, finds the token gone, and is refused cleanly.
  const user = await withoutRls(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ identifier: string }>>`
      SELECT identifier FROM verification_tokens
       WHERE token = ${tokenHash} AND expires > transaction_timestamp()
         FOR UPDATE`;
    if (locked.length === 0) return null;
    const owner = await tx.appUser.findUnique({
      where: { email: locked[0].identifier },
      select: { id: true },
    });
    if (!owner) return null;
    await tx.appUser.update({
      where: { id: owner.id },
      data: {
        passwordHash,
        // Revoke every existing JWT for this user.
        sessionVersion: { increment: 1 },
      },
    });
    await tx.verificationToken.delete({ where: { token: tokenHash } });
    return owner;
  });
  if (!user) throw new InvalidInputError('invalid or expired token');
  log.info('password_reset.consume.ok', { userId: user.id });
  return { userId: user.id };
}
