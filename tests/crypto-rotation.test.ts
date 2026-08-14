import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

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

const { encryptField, decryptField, __clearKeyCache } = await import('@/lib/crypto');

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
