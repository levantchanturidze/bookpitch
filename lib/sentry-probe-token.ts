import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// -----------------------------------------------------------------------------
// Short-lived, server-issued authorisation for the BROWSER Sentry probe.
//
// The browser probe has to run in a real browser against the deployed app, and
// the page that triggers it must not be openable by anyone who finds the URL.
// But the obvious credential — CRON_SECRET — must never reach client
// JavaScript, a URL, a log or a response.
//
// So the server issues a token DERIVED from the secret: an HMAC over the nonce
// and an expiry. It authorises exactly one probe, for a few minutes, and
// reveals nothing about the key. A leaked token buys an attacker one synthetic
// Sentry event before it expires.
//
// The nonce itself is not secret — it is a public correlation id that ties the
// server event, the browser event and the receipt together. It is generated
// with crypto randomness so it cannot be guessed or replayed from an earlier
// verification run.
// -----------------------------------------------------------------------------

/** Probe authorisation lifetime. Long enough for a browser to load a page. */
export const PROBE_TOKEN_TTL_MS = 5 * 60_000;

/** 16 random bytes, hex. Matches the /^[A-Za-z0-9_-]{8,64}$/ the probes accept. */
export function generateProbeNonce(): string {
  return randomBytes(16).toString('hex');
}

function sign(secret: string, nonce: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${nonce}.${expiresAt}`).digest('hex');
}

export function issueProbeToken(
  secret: string,
  nonce: string,
  now: number = Date.now(),
): { nonce: string; token: string; expiresAt: number } {
  const expiresAt = now + PROBE_TOKEN_TTL_MS;
  return { nonce, token: sign(secret, nonce, expiresAt), expiresAt };
}

/**
 * Constant-time verification.
 *
 * Returns a reason rather than a bare boolean so the caller can log WHY without
 * logging the token. Never throws on malformed input — a probe endpoint is a
 * place where a thrown error would itself be a signal.
 */
export function verifyProbeToken(
  secret: string,
  input: { nonce?: unknown; token?: unknown; expiresAt?: unknown },
  now: number = Date.now(),
): { ok: boolean; reason?: string } {
  const nonce = typeof input.nonce === 'string' ? input.nonce : '';
  const token = typeof input.token === 'string' ? input.token : '';
  const expiresAt = Number(input.expiresAt);

  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return { ok: false, reason: 'malformed nonce' };
  if (!/^[0-9a-f]{64}$/.test(token)) return { ok: false, reason: 'malformed token' };
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed expiry' };
  if (expiresAt <= now) return { ok: false, reason: 'token expired' };
  // Bound the forward window too: a token minted with a far-future expiry —
  // by a caller who somehow reached the issuer — must not be usable forever.
  if (expiresAt > now + PROBE_TOKEN_TTL_MS) return { ok: false, reason: 'expiry too far ahead' };

  const expected = Buffer.from(sign(secret, nonce, expiresAt), 'hex');
  const actual = Buffer.from(token, 'hex');
  if (expected.length !== actual.length) return { ok: false, reason: 'token mismatch' };
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'token mismatch' };
  return { ok: true };
}
