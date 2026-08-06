import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// -----------------------------------------------------------------------------
// Field-level encryption for special-category health data and MFA secrets.
//
// Algorithm: AES-256-GCM (authenticated encryption).
//
// Storage format (current — v1 with key identifier):
//   "v1:<key-id>:" + base64( iv[12] || ciphertext || tag[16] )
//
// Legacy format (written before key-id was added):
//   "v1:" + base64( iv[12] || ciphertext || tag[16] )
//   base64( iv[12] || ciphertext || tag[16] )  (oldest rows, no version prefix)
//
// All three formats are accepted by decryptField. New writes always use the
// current format with the active key ID.
//
// Key configuration:
//   FIELD_ENCRYPTION_KEY=<key-id>:<64-hex-chars>
//     e.g. "k1:0102030405..." — 32-byte key encoded as 64 hex chars
//   FIELD_ENCRYPTION_OLD_KEYS=<key-id>:<64-hex>,...
//     Comma-separated list of previous keys for decryption during rotation.
//
// Key rotation procedure:
//   1. Generate a new 32-byte key: openssl rand -hex 32
//   2. Pick a new key-id string (e.g. "k2").
//   3. Move current FIELD_ENCRYPTION_KEY to FIELD_ENCRYPTION_OLD_KEYS.
//   4. Set FIELD_ENCRYPTION_KEY=k2:<new-hex>.
//   5. Deploy. New writes use k2; old rows decrypt with k1 from OLD_KEYS.
//   6. Run scripts/rotate-encryption-key.ts (from a secure admin session)
//      to re-encrypt all rows with the new key.
//   7. Remove k1 from FIELD_ENCRYPTION_OLD_KEYS.
//
// Unknown key IDs fail closed — decryptField throws rather than silently
// returning garbage. Corrupted nonce/ciphertext/tag cause GCM auth failure.
// -----------------------------------------------------------------------------

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

type KeyEntry = { id: string; key: Buffer };

let cachedActive: KeyEntry | null = null;
let cachedOld: Map<string, Buffer> | null = null;

function parseKeySpec(spec: string): KeyEntry {
  const colon = spec.indexOf(':');
  if (colon < 1) {
    throw new Error('FIELD_ENCRYPTION_KEY must be "<key-id>:<64-hex-chars>"');
  }
  const id = spec.slice(0, colon);
  const hex = spec.slice(colon + 1);
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LEN) {
    throw new Error(
      `Key "${id}" must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes); got ${key.length}`,
    );
  }
  return { id, key };
}

function getActiveKey(): KeyEntry {
  if (cachedActive) return cachedActive;
  const spec = process.env.FIELD_ENCRYPTION_KEY;
  if (!spec) throw new Error('FIELD_ENCRYPTION_KEY is not set — check .env.local');
  cachedActive = parseKeySpec(spec);
  return cachedActive;
}

function getOldKeys(): Map<string, Buffer> {
  if (cachedOld) return cachedOld;
  const raw = process.env.FIELD_ENCRYPTION_OLD_KEYS ?? '';
  const map = new Map<string, Buffer>();
  for (const spec of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const entry = parseKeySpec(spec);
    map.set(entry.id, entry.key);
  }
  cachedOld = map;
  return map;
}

function findKey(keyId: string): Buffer {
  const active = getActiveKey();
  if (active.id === keyId) return active.key;
  const old = getOldKeys();
  const key = old.get(keyId);
  if (!key) {
    throw new Error(`Unknown encryption key-id "${keyId}" — check FIELD_ENCRYPTION_OLD_KEYS`);
  }
  return key;
}

/** Test-only: clear the key cache so env var changes in tests take effect. */
export function __clearKeyCache(): void {
  cachedActive = null;
  cachedOld = null;
}

/**
 * Encrypts `plaintext` with the active key. Returns `null` for null/empty
 * input so DB columns stay clean.
 *
 * Output format: "v1:<key-id>:" + base64( iv[12] || ciphertext || tag[16] )
 * Each call generates a fresh random 96-bit nonce, so identical plaintexts
 * produce distinct ciphertexts.
 */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  const { id, key } = getActiveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ct, tag]).toString('base64');
  return `v1:${id}:${payload}`;
}

/**
 * Decrypts a value produced by encryptField. Returns null for null/empty.
 *
 * Accepted formats (in order of precedence):
 *   "v1:<key-id>:<base64>" — current format (key-id present)
 *   "v1:<base64>"          — legacy format (no key-id; uses active key)
 *   "<base64>"             — oldest format (no prefix; uses active key)
 *
 * Throws on unknown key-id, tampered ciphertext (GCM auth tag mismatch),
 * or a blob too short to contain iv + tag.
 *
 * The legacy formats are decrypted with the active key. If the active key
 * has changed since the row was written, decryption will fail with a GCM
 * auth error — which is the correct behaviour (the row must be re-encrypted
 * during key rotation before the old key is retired).
 */
export function decryptField(blob: string | null | undefined): string | null {
  if (blob == null || blob === '') return null;

  let key: Buffer;
  let rawBase64: string;

  if (blob.startsWith('v1:')) {
    // Could be "v1:<key-id>:<base64>" or legacy "v1:<base64>"
    const rest = blob.slice(3); // strip "v1:"
    const nextColon = rest.indexOf(':');
    if (nextColon > 0) {
      // Determine whether the part before the colon is a key-id or the start
      // of base64. Base64 chars are [A-Za-z0-9+/=]; a colon is not valid
      // base64, so if there's another colon the first segment is a key-id.
      const candidateId = rest.slice(0, nextColon);
      const candidatePayload = rest.slice(nextColon + 1);
      // Key-ids use only word characters: [A-Za-z0-9_-].
      // If the candidate matches, treat it as a key-id.
      if (/^[A-Za-z0-9_-]+$/.test(candidateId)) {
        key = findKey(candidateId);
        rawBase64 = candidatePayload;
      } else {
        // Legacy "v1:<base64>" where the base64 happened to contain a colon
        // (impossible for standard base64, but be safe).
        key = getActiveKey().key;
        rawBase64 = rest;
      }
    } else {
      // Legacy "v1:<base64>" — no key-id section.
      key = getActiveKey().key;
      rawBase64 = rest;
    }
  } else {
    // Oldest format — raw base64 with no prefix.
    key = getActiveKey().key;
    rawBase64 = blob;
  }

  const buf = Buffer.from(rawBase64, 'base64');
  if (buf.length < IV_LEN + 16) {
    throw new Error('decryptField: blob too short to contain iv + tag');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(IV_LEN, buf.length - 16);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
