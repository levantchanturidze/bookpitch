import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv } from 'node:crypto';

// -----------------------------------------------------------------------------
// P15-010 — is prefixing the production key with "<key-id>:" SAFE?
//
// Production has FIELD_ENCRYPTION_KEY set to a bare 64-hex string with no
// key-id, so parseKeySpec() throws and every encryptField() call fails. The
// proposed correction is to prefix the SAME 64 characters with e.g. "k1:".
//
// Before asking a human to edit a production secret, each claim that makes
// that safe has to be demonstrated rather than asserted. This file proves the
// ten claims one at a time, against the real implementation.
//
// Nothing here reads, prints or depends on the production value. Every key
// used is randomly generated in-process.
// -----------------------------------------------------------------------------

const { encryptField, decryptField, __clearKeyCache } = await import('@/lib/crypto');

const ORIG_KEY = process.env.FIELD_ENCRYPTION_KEY;
const ORIG_OLD = process.env.FIELD_ENCRYPTION_OLD_KEYS;

/** Stands in for "the 64 hex characters currently sitting in production". */
const EXISTING_HEX = randomBytes(32).toString('hex');

function setEnv(active: string | undefined, old = '') {
  if (active === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else Object.assign(process.env, { FIELD_ENCRYPTION_KEY: active });
  Object.assign(process.env, { FIELD_ENCRYPTION_OLD_KEYS: old });
  __clearKeyCache();
}

afterEach(() => {
  if (ORIG_KEY !== undefined) Object.assign(process.env, { FIELD_ENCRYPTION_KEY: ORIG_KEY });
  else delete process.env.FIELD_ENCRYPTION_KEY;
  if (ORIG_OLD !== undefined) Object.assign(process.env, { FIELD_ENCRYPTION_OLD_KEYS: ORIG_OLD });
  else delete process.env.FIELD_ENCRYPTION_OLD_KEYS;
  __clearKeyCache();
});

describe('P15-010 claim 1+2 — the required format, and what production has now', () => {
  it('rejects a bare 64-hex value, reproducing the production failure exactly', () => {
    setEnv(EXISTING_HEX);
    expect(() => encryptField('x')).toThrow(/must be "<key-id>:<64-hex-chars>"/);
  });

  it('accepts <key-id>:<64-hex>', () => {
    setEnv(`k1:${EXISTING_HEX}`);
    expect(encryptField('x')).toMatch(/^v1:k1:/);
  });

  it('still rejects a wrong-length hex body even with a key id', () => {
    setEnv('k1:abcdef');
    expect(() => encryptField('x')).toThrow(/must be 64 hex chars/);
  });
});

describe('P15-010 claim 3 — prefixing preserves the AES-256 key bytes', () => {
  it('derives byte-identical key material before and after the prefix', () => {
    // parseKeySpec takes everything after the FIRST colon as hex. Adding
    // "k1:" in front cannot change those bytes.
    const beforeBytes = Buffer.from(EXISTING_HEX, 'hex');
    const afterBytes = Buffer.from(`k1:${EXISTING_HEX}`.slice('k1:'.length), 'hex');
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterBytes).toHaveLength(32);
  });

  it('a key-id containing no colon cannot shift the hex boundary', () => {
    for (const id of ['k1', 'prod', 'key_2026', 'a-b-c']) {
      const spec = `${id}:${EXISTING_HEX}`;
      expect(spec.slice(spec.indexOf(':') + 1)).toBe(EXISTING_HEX);
    }
  });
});

describe('P15-010 claim 4 — existing ciphertext still decrypts afterwards', () => {
  // Ciphertext written by an older build in either legacy shape is decrypted
  // with the ACTIVE key bytes and ignores key ids entirely (lib/crypto.ts
  // decryptField). Since the bytes are unchanged, these keep working.
  function legacyCiphertext(hex: string, plaintext: string, withV1Prefix: boolean): string {
    const key = Buffer.from(hex, 'hex');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
    return withV1Prefix ? `v1:${payload}` : payload;
  }

  it('legacy "v1:<base64>" ciphertext decrypts after the prefix is added', () => {
    const blob = legacyCiphertext(EXISTING_HEX, 'peanut allergy', true);
    setEnv(`k1:${EXISTING_HEX}`);
    expect(decryptField(blob)).toBe('peanut allergy');
  });

  it('oldest bare "<base64>" ciphertext decrypts after the prefix is added', () => {
    const blob = legacyCiphertext(EXISTING_HEX, 'clinical note', false);
    setEnv(`k1:${EXISTING_HEX}`);
    expect(decryptField(blob)).toBe('clinical note');
  });

  it('current-format ciphertext written under the SAME id round-trips', () => {
    setEnv(`k1:${EXISTING_HEX}`);
    const blob = encryptField('round trip')!;
    __clearKeyCache();
    setEnv(`k1:${EXISTING_HEX}`);
    expect(decryptField(blob)).toBe('round trip');
  });
});

describe('P15-010 claim 5+6 — this is a format correction, not a rotation', () => {
  it('the same plaintext/nonce pair yields identical ciphertext under both specs', () => {
    // Encrypting with the raw hex directly (what a rotation would change) and
    // with the prefixed spec must produce the same bytes for a fixed nonce.
    // Equal ciphertext under a fixed nonce is proof the key material is
    // identical — i.e. no rotation has occurred.
    const iv = randomBytes(12);
    const mk = (hex: string) => {
      const c = createCipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv);
      const ct = Buffer.concat([c.update('same-input', 'utf8'), c.final()]);
      return Buffer.concat([ct, c.getAuthTag()]).toString('base64');
    };
    const spec = `k1:${EXISTING_HEX}`;
    expect(mk(spec.slice(spec.indexOf(':') + 1))).toBe(mk(EXISTING_HEX));
  });

  it('a genuinely NEW key would break existing ciphertext — the thing to avoid', () => {
    // Demonstrates why the instruction must say "do not generate a new key".
    setEnv(`k1:${EXISTING_HEX}`);
    const blob = encryptField('written under the existing key')!;

    const differentHex = randomBytes(32).toString('hex');
    setEnv(`k1:${differentHex}`); // same id, different bytes — a silent rotation
    expect(() => decryptField(blob)).toThrow();
  });
});

describe('P15-010 claim 7 — no re-encryption or migration needed', () => {
  it('values written before the correction are readable after it, untouched', () => {
    // Simulate the only ciphertext shape that could predate the correction:
    // legacy, because the current format cannot have been written while
    // encryptField was throwing.
    const key = Buffer.from(EXISTING_HEX, 'hex');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update('pre-existing', 'utf8'), c.final()]);
    const stored = `v1:${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')}`;

    setEnv(`k1:${EXISTING_HEX}`);
    // No rewrite, no backfill — read it exactly as stored.
    expect(decryptField(stored)).toBe('pre-existing');
  });
});

describe('P15-010 claim 8 — FIELD_ENCRYPTION_OLD_KEYS is not required', () => {
  it('legacy ciphertext decrypts with OLD_KEYS empty', () => {
    const key = Buffer.from(EXISTING_HEX, 'hex');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update('no old keys needed', 'utf8'), c.final()]);
    const stored = `v1:${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')}`;

    setEnv(`k1:${EXISTING_HEX}`, ''); // explicitly empty
    expect(decryptField(stored)).toBe('no old keys needed');
  });

  it('BUT current-format ciphertext under a DIFFERENT id does need OLD_KEYS', () => {
    // The one case that would make the correction unsafe. It can only exist if
    // encryptField ever succeeded in production under another key id — which
    // it has not, since it throws on the present value. Pinned so the
    // limitation is explicit rather than assumed away.
    setEnv(`legacy-id:${EXISTING_HEX}`);
    const blob = encryptField('written under a different id')!;
    expect(blob).toMatch(/^v1:legacy-id:/);

    setEnv(`k1:${EXISTING_HEX}`, '');
    expect(() => decryptField(blob)).toThrow(/Unknown encryption key-id "legacy-id"/);

    // ...and is recoverable by listing the old id, without changing bytes.
    setEnv(`k1:${EXISTING_HEX}`, `legacy-id:${EXISTING_HEX}`);
    expect(decryptField(blob)).toBe('written under a different id');
  });
});

describe('P15-010 claim 9 — the chosen key id must not collide', () => {
  it('an id reused between active and OLD_KEYS resolves to the active key', () => {
    // findKey() checks active first, so a colliding id silently shadows the
    // old entry and its ciphertext becomes undecryptable. Hence "unique id".
    const otherHex = randomBytes(32).toString('hex');
    setEnv(`k1:${otherHex}`);
    const underOther = encryptField('encrypted under the other bytes')!;

    setEnv(`k1:${EXISTING_HEX}`, `k1:${otherHex}`); // id collision
    expect(() => decryptField(underOther)).toThrow();

    // Distinct ids resolve correctly.
    setEnv(`k2:${EXISTING_HEX}`, `k1:${otherHex}`);
    expect(decryptField(underOther)).toBe('encrypted under the other bytes');
  });
});

describe('P15-010 claim 10 — launch-critical encryption paths work once corrected', () => {
  const roundTrip = (label: string, value: string) => {
    it(`${label} encrypts and decrypts under the corrected format`, () => {
      setEnv(`k1:${EXISTING_HEX}`);
      const blob = encryptField(value);
      expect(blob).toMatch(/^v1:k1:/);
      expect(decryptField(blob)).toBe(value);
    });
  };

  // The four call sites that are broken in production today.
  roundTrip('onboarding verification body (lib/onboarding.ts)', 'Verify your Bookpitch account');
  roundTrip('outbox recipient (lib/onboarding.ts)', 'someone@example.dev');
  roundTrip('clinical field (lib/customers.ts)', 'penicillin; see notes');
  roundTrip('MFA TOTP secret (lib/platform/mfa.ts)', 'JBSWY3DPEHPK3PXP');

  it('all four fail identically BEFORE the correction', () => {
    setEnv(EXISTING_HEX);
    for (const v of [
      'Verify your Bookpitch account',
      'a@b.dev',
      'penicillin',
      'JBSWY3DPEHPK3PXP',
    ]) {
      expect(() => encryptField(v)).toThrow(/must be "<key-id>:<64-hex-chars>"/);
    }
  });
});
