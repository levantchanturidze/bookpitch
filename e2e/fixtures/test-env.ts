// -----------------------------------------------------------------------------
// Test-only environment values shared by playwright.config.ts (which passes them
// to `next start`) and e2e/fixtures/db.ts (which needs the SAME values to read
// what the server wrote).
//
// One source of truth on purpose. EMAIL_PRIVACY_HMAC_KEY keys the address hash
// on every email_outbox row; if the server and the fixtures disagree about it,
// cleanup finds nothing and quietly leaves rows behind — which is exactly the
// kind of drift that makes the next run's fixtures look haunted.
//
// Not secrets. They salt rate-limit buckets and an email index hash in a local
// test database, and ci.yml already uses values of this shape. A real value in
// the environment always wins, so a developer or CI can override either.
//
// FIELD_ENCRYPTION_KEY is deliberately absent: defaulting it would make every
// already-encrypted row in a developer's database unreadable.
// -----------------------------------------------------------------------------

const TEST_RATE_LIMIT_HMAC_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_EMAIL_PRIVACY_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000002';

export function rateLimitHmacKey(): string {
  return process.env.RATE_LIMIT_HMAC_KEY ?? TEST_RATE_LIMIT_HMAC_KEY;
}

export function emailPrivacyHmacKey(): string {
  return process.env.EMAIL_PRIVACY_HMAC_KEY ?? TEST_EMAIL_PRIVACY_HMAC_KEY;
}
