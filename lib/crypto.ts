import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// -----------------------------------------------------------------------------
// Field-level encryption for special-category health data.
//
// Algorithm: AES-256-GCM (authenticated). Storage format:
//   base64( iv || ciphertext || tag )   — 12-byte IV, 16-byte tag.
//
// The key lives in FIELD_ENCRYPTION_KEY (32-byte hex). Rotating it means old
// rows can't decrypt — key-rotation tooling lands in P3.3 (compliance).
// -----------------------------------------------------------------------------

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('FIELD_ENCRYPTION_KEY is not set — check .env.local');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LEN) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes); got ${key.length}`,
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Encrypts `plaintext`. Returns `null` for null/empty input so DB stays clean.
 * Idempotent: never re-encrypts already-encrypted values (caller responsibility).
 */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypts a value produced by encryptField. Returns null for null/empty.
 * Throws on tampered ciphertext (GCM auth tag mismatch).
 */
export function decryptField(blob: string | null | undefined): string | null {
  if (blob == null || blob === '') return null;
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + 16) {
    throw new Error('encryptField: blob too short to contain iv + tag');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(IV_LEN, buf.length - 16);
  const decipher = createDecipheriv(ALG, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
