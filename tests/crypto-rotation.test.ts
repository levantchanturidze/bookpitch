import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv } from 'node:crypto';

// -----------------------------------------------------------------------------
// Field encryption key rotation tests.
//
// Verifies that:
//   • Data encrypted with key K1 can be decrypted after K1 is moved to
//     FIELD_ENCRYPTION_OLD_KEYS and a new K2 is set as the active key.
//   • New writes use the new active key (body starts with "v1:<k2-id>:").
//   • A key not in either active or OLD_KEYS causes decryptField to throw.
//   • The key cache is properly cleared between rotations (__clearKeyCache).
// -----------------------------------------------------------------------------

const { encryptField, decryptField, hashEmailForIndex, __clearKeyCache, __clearEmailHmacKeyCache } =
  await import('@/lib/crypto');

function makeKey(): string {
  return randomBytes(32).toString('hex');
}

const K1_ID = 'rot-test-k1';
const K2_ID = 'rot-test-k2';
const K1_HEX = makeKey();
const K2_HEX = makeKey();

const origKey = process.env.FIELD_ENCRYPTION_KEY;
const origOld = process.env.FIELD_ENCRYPTION_OLD_KEYS;

beforeEach(() => {
  // Start fresh with K1 as the active key and no old keys.
  Object.assign(process.env, {
    FIELD_ENCRYPTION_KEY: `${K1_ID}:${K1_HEX}`,
    FIELD_ENCRYPTION_OLD_KEYS: '',
  });
  __clearKeyCache();
});

afterEach(() => {
  // Restore original key configuration so other tests are unaffected.
  if (origKey !== undefined) {
    Object.assign(process.env, { FIELD_ENCRYPTION_KEY: origKey });
  } else {
    delete process.env.FIELD_ENCRYPTION_KEY;
  }
  if (origOld !== undefined) {
    Object.assign(process.env, { FIELD_ENCRYPTION_OLD_KEYS: origOld });
  } else {
    delete process.env.FIELD_ENCRYPTION_OLD_KEYS;
  }
  __clearKeyCache();
});

describe('crypto rotation — encrypt with K1, rotate to K2, K1 in OLD_KEYS', () => {
  it('data encrypted with K1 decrypts after K1 moved to OLD_KEYS and K2 is active', () => {
    const plaintext = 'sensitive-field-value-encrypted-with-k1';

    // Step 1: encrypt with K1 active.
    const ciphertext = encryptField(plaintext)!;
    expect(ciphertext).toMatch(new RegExp(`^v1:${K1_ID}:`));

    // Step 2: rotate — K1 → OLD_KEYS, K2 → active.
    Object.assign(process.env, {
      FIELD_ENCRYPTION_KEY: `${K2_ID}:${K2_HEX}`,
      FIELD_ENCRYPTION_OLD_KEYS: `${K1_ID}:${K1_HEX}`,
    });
    __clearKeyCache();

    // Step 3: decryptField must succeed using K1 from OLD_KEYS.
    const decrypted = decryptField(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('new writes after rotation use the new active key (K2)', () => {
    // Rotate first.
    Object.assign(process.env, {
      FIELD_ENCRYPTION_KEY: `${K2_ID}:${K2_HEX}`,
      FIELD_ENCRYPTION_OLD_KEYS: `${K1_ID}:${K1_HEX}`,
    });
    __clearKeyCache();

    const ciphertext = encryptField('new-plaintext')!;
    expect(ciphertext).toMatch(new RegExp(`^v1:${K2_ID}:`));

    // Decrypt with the new key.
    expect(decryptField(ciphertext)).toBe('new-plaintext');
  });

  it('decryptField throws for a key-id that is in neither active nor OLD_KEYS', () => {
    // Encrypt with K1.
    const ciphertext = encryptField('data')!;

    // Rotate to K2 WITHOUT carrying K1 into OLD_KEYS.
    Object.assign(process.env, {
      FIELD_ENCRYPTION_KEY: `${K2_ID}:${K2_HEX}`,
      FIELD_ENCRYPTION_OLD_KEYS: '',
    });
    __clearKeyCache();

    // K1 is now unknown — must throw.
    expect(() => decryptField(ciphertext)).toThrow(/Unknown encryption key-id/);
  });

  it('round-trip: encrypt with K2, decrypt without rotation', () => {
    Object.assign(process.env, {
      FIELD_ENCRYPTION_KEY: `${K2_ID}:${K2_HEX}`,
      FIELD_ENCRYPTION_OLD_KEYS: '',
    });
    __clearKeyCache();

    const plain = 'another-sensitive-value';
    const ct = encryptField(plain)!;
    expect(decryptField(ct)).toBe(plain);
  });
});

// ── Legacy format round-trips ─────────────────────────────────────────────────
//
// decryptField must handle three historical ciphertext formats:
//   1. Current:  "v1:<key-id>:<base64>"
//   2. Legacy:   "v1:<base64>"         (no key-id; uses active key)
//   3. Oldest:   "<base64>"            (no prefix at all; uses active key)

function aesGcmEncrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

describe('crypto legacy format round-trips', () => {
  it('decryptField handles legacy "v1:<base64>" format (no key-id)', () => {
    const key = Buffer.from(K1_HEX, 'hex');
    const payload = aesGcmEncrypt(key, 'legacy-no-key-id');
    const blob = `v1:${payload.toString('base64')}`;
    expect(decryptField(blob)).toBe('legacy-no-key-id');
  });

  it('decryptField handles oldest bare "<base64>" format (no v1: prefix)', () => {
    const key = Buffer.from(K1_HEX, 'hex');
    const payload = aesGcmEncrypt(key, 'oldest-no-prefix');
    const blob = payload.toString('base64');
    // Must not start with "v1:" to hit the bare-base64 branch.
    expect(blob.startsWith('v1:')).toBe(false);
    expect(decryptField(blob)).toBe('oldest-no-prefix');
  });

  it('decryptField with key-id still works after rotation (current format)', () => {
    const ciphertext = encryptField('current-format-value')!;
    expect(ciphertext).toMatch(/^v1:[A-Za-z0-9_-]+:/);
    expect(decryptField(ciphertext)).toBe('current-format-value');
  });
});

// ── HMAC missing-key production failure ───────────────────────────────────────

describe('hashEmailForIndex — production fail-closed when key is absent', () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origHmacKey = process.env.EMAIL_PRIVACY_HMAC_KEY;

  afterEach(() => {
    Object.assign(process.env, { NODE_ENV: origNodeEnv });
    if (origHmacKey !== undefined) process.env.EMAIL_PRIVACY_HMAC_KEY = origHmacKey;
    else delete process.env.EMAIL_PRIVACY_HMAC_KEY;
    __clearEmailHmacKeyCache();
  });

  it('throws in production when EMAIL_PRIVACY_HMAC_KEY is absent', () => {
    delete process.env.EMAIL_PRIVACY_HMAC_KEY;
    Object.assign(process.env, { NODE_ENV: 'production' });
    __clearEmailHmacKeyCache();
    expect(() => hashEmailForIndex('any@example.com')).toThrow(/EMAIL_PRIVACY_HMAC_KEY/);
  });

  it('succeeds in non-production when only FIELD_ENCRYPTION_KEY is set', () => {
    delete process.env.EMAIL_PRIVACY_HMAC_KEY;
    Object.assign(process.env, { NODE_ENV: 'test' });
    __clearEmailHmacKeyCache();
    // Falls back to FIELD_ENCRYPTION_KEY — must not throw.
    const result = hashEmailForIndex('fallback@example.com');
    expect(result).toHaveLength(64);
  });
});

describe('crypto rotation — null/empty passthrough', () => {
  it('encryptField(null) returns null', () => {
    expect(encryptField(null)).toBeNull();
  });

  it('encryptField("") returns null', () => {
    expect(encryptField('')).toBeNull();
  });

  it('decryptField(null) returns null', () => {
    expect(decryptField(null)).toBeNull();
  });
});
