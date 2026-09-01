import { Client } from 'pg';
import { createHmac } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { emailPrivacyHmacKey } from './test-env';

loadEnv();
loadEnv({ path: '.env.local', override: true });

// -----------------------------------------------------------------------------
// Direct database access for the E2E journeys.
//
// Two things need it and cannot get them any other way:
//
//   • The signup verification token. It is 256-bit random, sent by email, and
//     only ever stored as a SHA-256 hash (prisma/schema.prisma,
//     PendingRegistration.tokenHash). The only place the raw token exists is
//     the queued email body, which is AES-256-GCM encrypted at rest. Without
//     reading and decrypting that row, Journey 3 can only reach
//     /onboard/pending and stops one step short of "successful application
//     state".
//
//   • Cleanup. A signup journey creates a real organisation, a real user and a
//     real location. Leaving them behind makes the next run's fixtures drift
//     and pollutes the counts other suites assert on.
//
// Uses `pg` rather than Prisma deliberately: this runs inside Playwright's own
// TypeScript pipeline, and a raw client has no client-generation step, no
// module-load-time connection URL check, and no ESM/alias surprises.
// -----------------------------------------------------------------------------

function adminUrl(): string {
  const url =
    process.env.DATABASE_URL_SUPERUSER_SESSION ??
    process.env.ADMIN_DATABASE_URL ??
    process.env.DATABASE_URL_SUPERUSER_TXPOOL ??
    process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL available for the E2E fixtures.');
  return url;
}

/**
 * Mirrors lib/crypto.ts::hashEmailForIndex — HMAC-SHA256 over
 * `'email-index:' + email.toLowerCase()`, keyed by EMAIL_PRIVACY_HMAC_KEY.
 * Lets cleanup find a row by recipient without decrypting anything.
 */
function hashEmailForIndex(email: string): string {
  // Same value the server used to write the row — see e2e/fixtures/test-env.ts.
  return createHmac('sha256', Buffer.from(emailPrivacyHmacKey(), 'hex'))
    .update('email-index:')
    .update(email.toLowerCase())
    .digest('hex');
}

export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Decrypt a field written by lib/crypto.ts::encryptField.
 *
 * The current format is `v1:<key-id>:<base64(iv|ciphertext|tag)>` — THREE
 * colon-separated parts, not two — with AES-256-GCM, a 12-byte IV and a 16-byte
 * tag. lib/crypto.ts also still reads two older shapes, so the payload is taken
 * as everything after the LAST colon rather than the first.
 *
 * Reimplemented here rather than imported so this fixture does not pull the
 * application's module graph into Playwright's runtime. If the format ever
 * changes, tests/crypto-rotation.test.ts fails first and loudly.
 */
export async function decryptOutboxField(blob: string): Promise<string | null> {
  const { createDecipheriv } = await import('node:crypto');
  const spec = process.env.FIELD_ENCRYPTION_KEY;
  if (!spec) throw new Error('FIELD_ENCRYPTION_KEY is required to read a queued email body.');
  const colon = spec.indexOf(':');
  const keyHex = colon >= 0 ? spec.slice(colon + 1) : spec;
  const key = Buffer.from(keyHex, 'hex');

  // "v1:<key-id>:<base64>" | "v1:<base64>" | "<base64>"
  const raw = Buffer.from(blob.slice(blob.lastIndexOf(':') + 1), 'base64');
  if (raw.length < 12 + 16) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The most recent queued/sent verification email for `email`, decrypted. */
export async function findVerificationEmailBody(email: string): Promise<string | null> {
  return withDb(async (c) => {
    const { rows } = await c.query<{
      body: string;
      body_encrypted: boolean;
      to_address: string;
      to_address_encrypted: boolean;
    }>(
      `SELECT body, body_encrypted, to_address, to_address_encrypted
         FROM email_outbox
        WHERE purpose = 'onboard.verify'
        ORDER BY created_at DESC
        LIMIT 25`,
    );
    for (const r of rows) {
      const to = r.to_address_encrypted ? await decryptOutboxField(r.to_address) : r.to_address;
      if (to?.toLowerCase() !== email.toLowerCase()) continue;
      return r.body_encrypted ? await decryptOutboxField(r.body) : r.body;
    }
    return null;
  });
}

/**
 * Retire everything a signup journey created for `email`.
 *
 * Deliberately not a plain DELETE. A completed signup writes audit rows, and
 * `audit_log` is append-only — the `audit_log_no_delete` trigger from migration
 * 20260727170000 blocks DELETE for every role including the superuser, and
 * `audit_log_organization_id_fkey` then blocks deleting the organisation itself:
 *
 *     update or delete on table "organizations" violates foreign key
 *     constraint "audit_log_organization_id_fkey" on table "audit_log"
 *
 * That constraint is a product invariant (CLAUDE.md #3), not an obstacle to
 * work around. So cleanup deletes what it can — the pending registration and
 * the queued verification email, neither of which is audited — and ARCHIVES the
 * organisation when the audit trail pins it. An archived organisation is inert:
 * lib/rbac/can.ts denies every org-plane permission for status 'archived'.
 *
 * Scoped by the exact address the test generated, never by pattern, so it can
 * only ever touch its own rows.
 */
export async function deleteSignupArtifacts(email: string): Promise<void> {
  await withDb(async (c) => {
    // One transaction: the org-owner invariant trigger (migration
    // 20260813000002) is DEFERRED and fires at COMMIT. Deleting the owner's
    // membership in its own implicit transaction trips "org has owner_user_id
    // set but no matching active owner membership" and leaves the organisation
    // behind for the next run to trip over.
    await c.query('BEGIN');
    try {
      await c.query('DELETE FROM pending_registrations WHERE lower(email) = lower($1)', [email]);
      // to_address is encrypted, so match on the address HMAC — scoped to this
      // one journey's address, never a time window, which would take other
      // suites' rows with it.
      await c.query('DELETE FROM email_outbox WHERE purpose = $1 AND to_address_hash = $2', [
        'onboard.verify',
        hashEmailForIndex(email),
      ]);

      const { rows: users } = await c.query<{ id: string }>(
        'SELECT id FROM app_users WHERE lower(email) = lower($1)',
        [email],
      );

      for (const u of users) {
        const { rows: orgs } = await c.query<{ id: string; audited: string }>(
          `SELECT o.id,
                  (SELECT count(*) FROM audit_log a WHERE a.organization_id = o.id)::text AS audited
             FROM organizations o
            WHERE o.owner_user_id = $1`,
          [u.id],
        );

        let anyAudited = false;
        for (const o of orgs) {
          if (Number(o.audited) > 0) {
            anyAudited = true;
            await c.query("UPDATE organizations SET status = 'archived' WHERE id = $1", [o.id]);
          } else {
            await c.query('DELETE FROM organizations WHERE id = $1', [o.id]);
          }
        }

        // The user can only go if nothing audited retains it, for the same
        // reason: audit_log.actor_user_id is a foreign key onto app_users.
        const { rows: acted } = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM audit_log WHERE actor_user_id = $1',
          [u.id],
        );
        if (!anyAudited && Number(acted[0].n) === 0) {
          await c.query('DELETE FROM memberships WHERE user_id = $1', [u.id]);
          await c.query('DELETE FROM app_users WHERE id = $1', [u.id]);
        }
      }

      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}
