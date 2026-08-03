import { randomBytes, createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { getEmailProvider } from '@/lib/messaging';
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
//   - Emails the RAW token via the configured provider (or logs the URL in
//     dev with EMAIL_PROVIDER=mock).
//
// consumeReset(rawToken, newPassword):
//   - Hashes rawToken, looks up the row, checks expiry.
//   - Rehashes password with argon2, updates AppUser, bumps sessionVersion.
//   - Deletes the reset row so it cannot be reused.
//   - The bumped sessionVersion invalidates ALL existing JWTs for the user
//     within ~5s (see auth.ts session() cache TTL).
// -----------------------------------------------------------------------------

const TOKEN_TTL_MS = 60 * 60 * 1000;

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
  const expires = new Date(Date.now() + TOKEN_TTL_MS);

  await withoutRls(async (tx) => {
    // Drop any prior in-flight tokens for this email so only the newest is valid.
    await tx.verificationToken.deleteMany({ where: { identifier: email } });
    await tx.verificationToken.create({
      data: { identifier: email, token: tokenHash, expires },
    });
  });

  const origin = process.env.APP_URL ?? 'http://localhost:3000';
  const url = `${origin}/reset?token=${encodeURIComponent(rawToken)}`;
  try {
    const provider = getEmailProvider();
    await provider.send(
      email,
      'Reset your Bookpitch password',
      `A password reset was requested for your account.\n\nOpen this link within the next hour to choose a new password:\n\n${url}\n\nIf you didn't request this, you can safely ignore the message.`,
    );
    log.info('password_reset.request.sent');
  } catch (err) {
    // Provider failure is not fatal — the mock provider succeeds trivially,
    // and a real provider outage should not block the user's request loop.
    log.warn('password_reset.request.provider_failed', { error: (err as Error).message });
  }
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
  const row = await unsafePrismaAdmin.verificationToken.findUnique({ where: { token: tokenHash } });
  if (!row) throw new InvalidInputError('invalid or expired token');
  if (row.expires.getTime() < Date.now()) {
    // Best-effort cleanup; don't leak the reason.
    await unsafePrismaAdmin.verificationToken.delete({ where: { token: tokenHash } }).catch(() => {});
    throw new InvalidInputError('invalid or expired token');
  }

  const user = await withoutRls((tx) =>
    tx.appUser.findUnique({
      where: { email: row.identifier },
      select: { id: true, sessionVersion: true },
    }),
  );
  if (!user) throw new InvalidInputError('invalid or expired token');

  const passwordHash = await hash(newPassword);
  await withoutRls(async (tx) => {
    await tx.appUser.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // Revoke every existing JWT for this user.
        sessionVersion: { increment: 1 },
      },
    });
    await tx.verificationToken.delete({ where: { token: tokenHash } });
  });
  log.info('password_reset.consume.ok', { userId: user.id });
  return { userId: user.id };
}
