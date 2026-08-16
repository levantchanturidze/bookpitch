#!/usr/bin/env tsx
// scripts/rotate-encryption-key.ts
//
// Safe, resumable field-encryption key rotation utility.
//
// Usage:
//   1. Set FIELD_ENCRYPTION_KEY to the new key (e.g. "k2:<hex>").
//   2. Add the old key to FIELD_ENCRYPTION_OLD_KEYS (e.g. "k1:<hex>").
//   3. Run this script from a secure admin session:
//        DATABASE_URL_SUPERUSER_SESSION=... tsx scripts/rotate-encryption-key.ts
//   4. Verify: the script prints a summary of rows re-encrypted per table.
//   5. Once all rows are re-encrypted, remove the old key from OLD_KEYS.
//
// Safety invariants:
//   • Resumable: rows whose blob already starts with "v1:<new-key-id>:" are skipped.
//   • Batch updates use explicit WHERE id = ... to avoid touching unintended rows.
//   • Requires DATABASE_URL_SUPERUSER_SESSION (schema owner / BYPASSRLS role) so
//     all rows are visible. Do NOT run under the app role — RLS would skip rows.
//   • No secrets are printed. Progress is logged as row counts only.
//   • If the script fails mid-run, re-run it: rotated rows are idempotently skipped.
//
// Exit codes:
//   0  — all rows rotated (or already on the new key)
//   1  — error (check stderr for details)

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encryptField, decryptField, hashEmailForIndex, __clearKeyCache } from '../lib/crypto';

// Superuser connection — required to read/write rows regardless of RLS policy.
const databaseUrl = process.env.DATABASE_URL_SUPERUSER_SESSION;
if (!databaseUrl) {
  console.error(
    'ERROR: DATABASE_URL_SUPERUSER_SESSION is required (schema owner / BYPASSRLS role).',
  );
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

// Resolve the active key-id for the "already rotated" skip check.
__clearKeyCache();
const activeKeySpec = process.env.FIELD_ENCRYPTION_KEY ?? '';
const colonIdx = activeKeySpec.indexOf(':');
if (colonIdx < 1) {
  console.error('ERROR: FIELD_ENCRYPTION_KEY must be "<key-id>:<64-hex-chars>".');
  process.exit(1);
}
const activeKeyId = activeKeySpec.slice(0, colonIdx);

function isRotated(blob: string | null | undefined): boolean {
  return typeof blob === 'string' && blob.startsWith(`v1:${activeKeyId}:`);
}

function reencrypt(blob: string | null | undefined): string | null {
  if (!blob) return null;
  if (isRotated(blob)) return blob;
  const plain = decryptField(blob);
  if (plain === null) return null;
  return encryptField(plain);
}

const BATCH = 500;

// ── app_users: mfa_totp, mfa_totp_pending ─────────────────────────────────────

async function rotateMfaSecrets(): Promise<void> {
  console.log('\n[app_users MFA secrets] scanning...');
  let cursor: string | undefined;
  let total = 0;
  let rotated = 0;
  let skipped = 0;

  while (true) {
    type Row = { id: string; mfa_totp: string | null; mfa_totp_pending: string | null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Row[] = (await (prisma as any).$queryRawUnsafe(
      cursor
        ? `SELECT id, mfa_totp, mfa_totp_pending FROM app_users
           WHERE (mfa_totp IS NOT NULL OR mfa_totp_pending IS NOT NULL) AND id > $1::uuid
           ORDER BY id LIMIT $2`
        : `SELECT id, mfa_totp, mfa_totp_pending FROM app_users
           WHERE (mfa_totp IS NOT NULL OR mfa_totp_pending IS NOT NULL)
           ORDER BY id LIMIT $1`,
      ...(cursor ? [cursor, BATCH] : [BATCH]),
    )) as Row[];

    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      const needsTotp = row.mfa_totp && !isRotated(row.mfa_totp);
      const needsPending = row.mfa_totp_pending && !isRotated(row.mfa_totp_pending);

      if (!needsTotp && !needsPending) {
        skipped++;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).$queryRawUnsafe(
          `UPDATE app_users SET mfa_totp = $1, mfa_totp_pending = $2 WHERE id = $3::uuid`,
          reencrypt(row.mfa_totp),
          reencrypt(row.mfa_totp_pending),
          row.id,
        );
        rotated++;
      }
    }

    cursor = rows[rows.length - 1].id;
    process.stdout.write(`\r[app_users MFA] ${total} processed, ${rotated} rotated`);
    if (rows.length < BATCH) break;
  }
  console.log(`\n[app_users MFA] done: ${rotated} rotated, ${skipped} skipped, ${total} total`);
}

// ── customers: allergies, clinical_notes ──────────────────────────────────────

async function rotateCustomerFields(): Promise<void> {
  console.log('\n[customers clinical fields] scanning...');
  let cursor: string | undefined;
  let total = 0;
  let rotated = 0;
  let skipped = 0;

  while (true) {
    type Row = { id: string; allergies: string | null; clinical_notes: string | null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Row[] = (await (prisma as any).$queryRawUnsafe(
      cursor
        ? `SELECT id, allergies, clinical_notes FROM customers
           WHERE (allergies IS NOT NULL OR clinical_notes IS NOT NULL) AND id > $1::uuid
           ORDER BY id LIMIT $2`
        : `SELECT id, allergies, clinical_notes FROM customers
           WHERE (allergies IS NOT NULL OR clinical_notes IS NOT NULL)
           ORDER BY id LIMIT $1`,
      ...(cursor ? [cursor, BATCH] : [BATCH]),
    )) as Row[];

    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      const needsAllergies = row.allergies && !isRotated(row.allergies);
      const needsClinical = row.clinical_notes && !isRotated(row.clinical_notes);

      if (!needsAllergies && !needsClinical) {
        skipped++;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).$queryRawUnsafe(
          `UPDATE customers SET allergies = $1, clinical_notes = $2 WHERE id = $3::uuid`,
          reencrypt(row.allergies),
          reencrypt(row.clinical_notes),
          row.id,
        );
        rotated++;
      }
    }

    cursor = rows[rows.length - 1].id;
    process.stdout.write(`\r[customers] ${total} processed, ${rotated} rotated`);
    if (rows.length < BATCH) break;
  }
  console.log(`\n[customers] done: ${rotated} rotated, ${skipped} skipped, ${total} total`);
}

// ── email_outbox: body (when body_encrypted=true) ─────────────────────────────

async function rotateOutboxBodies(): Promise<void> {
  console.log('\n[email_outbox encrypted bodies] scanning...');
  let cursor: string | undefined;
  let total = 0;
  let rotated = 0;
  let skipped = 0;

  while (true) {
    type Row = { id: string; body: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Row[] = (await (prisma as any).$queryRawUnsafe(
      cursor
        ? `SELECT id, body FROM email_outbox
           WHERE body_encrypted = true AND id > $1::uuid
           ORDER BY id LIMIT $2`
        : `SELECT id, body FROM email_outbox
           WHERE body_encrypted = true
           ORDER BY id LIMIT $1`,
      ...(cursor ? [cursor, BATCH] : [BATCH]),
    )) as Row[];

    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      if (isRotated(row.body)) {
        skipped++;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).$queryRawUnsafe(
          `UPDATE email_outbox SET body = $1 WHERE id = $2::uuid`,
          reencrypt(row.body),
          row.id,
        );
        rotated++;
      }
    }

    cursor = rows[rows.length - 1].id;
    process.stdout.write(`\r[email_outbox] ${total} processed, ${rotated} rotated`);
    if (rows.length < BATCH) break;
  }
  console.log(`\n[email_outbox] done: ${rotated} rotated, ${skipped} skipped, ${total} total`);
}

// ── email_outbox: to_address (when to_address_encrypted=true) ─────────────────

async function rotateOutboxToAddresses(): Promise<void> {
  console.log('\n[email_outbox encrypted to_address] scanning...');
  let cursor: string | undefined;
  let total = 0;
  let rotated = 0;
  let skipped = 0;

  while (true) {
    type Row = { id: string; to_address: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Row[] = (await (prisma as any).$queryRawUnsafe(
      cursor
        ? `SELECT id, to_address FROM email_outbox
           WHERE to_address_encrypted = true AND id > $1::uuid
           ORDER BY id LIMIT $2`
        : `SELECT id, to_address FROM email_outbox
           WHERE to_address_encrypted = true
           ORDER BY id LIMIT $1`,
      ...(cursor ? [cursor, BATCH] : [BATCH]),
    )) as Row[];

    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      if (isRotated(row.to_address)) {
        skipped++;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).$queryRawUnsafe(
          `UPDATE email_outbox SET to_address = $1 WHERE id = $2::uuid`,
          reencrypt(row.to_address),
          row.id,
        );
        rotated++;
      }
    }

    cursor = rows[rows.length - 1].id;
    process.stdout.write(`\r[email_outbox to_address] ${total} processed, ${rotated} rotated`);
    if (rows.length < BATCH) break;
  }
  console.log(
    `\n[email_outbox to_address] done: ${rotated} rotated, ${skipped} skipped, ${total} total`,
  );
}

// ── email_outbox: backfill plaintext to_address rows ─────────────────────────
//
// Rows created before migration 20260814000003 have to_address_encrypted=false
// and to_address_hash=NULL. This step encrypts those plaintext addresses and
// sets the HMAC hash so the cancel/dedup queries work correctly.
//
// Idempotent: rows already encrypted (to_address_encrypted=true) are skipped.
// Safe: each UPDATE touches only the specific row via id.
//
// DRY-RUN inventory: set DRY_RUN=1 to print counts without writing.
//
// External blocker: this step reads and re-writes plaintext email addresses
// from the outbox. If run against production, the operator must confirm that
// DATABASE_URL_SUPERUSER_SESSION points to the correct RLS-bypassing role and
// that EMAIL_PRIVACY_HMAC_KEY is set to the same value used by the application.
// Local backfill is not possible without the production DB connection.

async function backfillOutboxToAddresses(): Promise<void> {
  const isDryRun = process.env.DRY_RUN === '1';
  console.log(`\n[email_outbox to_address backfill]${isDryRun ? ' DRY-RUN' : ''} scanning...`);

  // Inventory: count plaintext rows first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [{ cnt }] = (await (prisma as any).$queryRawUnsafe(
    `SELECT COUNT(*)::int AS cnt FROM email_outbox WHERE to_address_encrypted = false`,
  )) as [{ cnt: number }];
  console.log(`[email_outbox to_address backfill] ${cnt} plaintext row(s) found`);

  if (isDryRun) {
    console.log('[email_outbox to_address backfill] DRY-RUN — no writes performed');
    return;
  }

  let cursor: string | undefined;
  let total = 0;
  let backfilled = 0;

  while (true) {
    type Row = { id: string; to_address: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Row[] = (await (prisma as any).$queryRawUnsafe(
      cursor
        ? `SELECT id, to_address FROM email_outbox
           WHERE to_address_encrypted = false AND id > $1::uuid
           ORDER BY id LIMIT $2`
        : `SELECT id, to_address FROM email_outbox
           WHERE to_address_encrypted = false
           ORDER BY id LIMIT $1`,
      ...(cursor ? [cursor, BATCH] : [BATCH]),
    )) as Row[];

    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      const encrypted = encryptField(row.to_address);
      if (!encrypted) {
        console.warn(`  [skip] id=${row.id} — encryptField returned null (key misconfigured?)`);
        continue;
      }
      const hash = hashEmailForIndex(row.to_address);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$queryRawUnsafe(
        `UPDATE email_outbox
         SET to_address = $1, to_address_encrypted = true, to_address_hash = $2
         WHERE id = $3::uuid AND to_address_encrypted = false`,
        encrypted,
        hash,
        row.id,
      );
      backfilled++;
    }

    cursor = rows[rows.length - 1].id;
    process.stdout.write(`\r[email_outbox backfill] ${total} processed, ${backfilled} backfilled`);
    if (rows.length < BATCH) break;
  }

  // Post-rotation verification: confirm no plaintext rows remain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [{ remaining }] = (await (prisma as any).$queryRawUnsafe(
    `SELECT COUNT(*)::int AS remaining FROM email_outbox WHERE to_address_encrypted = false`,
  )) as [{ remaining: number }];

  console.log(
    `\n[email_outbox backfill] done: ${backfilled} backfilled of ${total} processed, ${remaining} plaintext row(s) remaining`,
  );
  if (remaining > 0) {
    console.error(`ERROR: ${remaining} row(s) still have plaintext to_address after backfill.`);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`rotate-encryption-key: active key-id = "${activeKeyId}"`);
console.log('Rows already on the active key are skipped (safe to re-run).\n');

try {
  await rotateMfaSecrets();
  await rotateCustomerFields();
  await rotateOutboxBodies();
  await rotateOutboxToAddresses();
  await backfillOutboxToAddresses();
  console.log(
    '\nKey rotation complete. Verify counts above, then remove the old key from OLD_KEYS.',
  );
} catch (err) {
  console.error('\nKey rotation failed:', err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
} finally {
  await prisma.$disconnect().catch(() => {});
}
