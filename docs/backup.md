# Database backup & restore

Bookpitch stores patient records — a backup that leaves the EU region
defeats the whole GDPR + Georgia-data-law posture the app is built on.
Both scripts assume the destination is in the same EU region as the
database (Frankfurt).

## Contract

- **Backup**: `scripts/backup-db.sh <destination>` runs `pg_dump` against
  `DIRECT_URL`, encrypts with GPG symmetric AES-256, writes the blob to
  `<destination>`.
- **Restore drill**: `scripts/restore-db.sh <source>` decrypts the same
  blob, spins up a **temporary** Postgres container, restores into it,
  and runs sanity `SELECT`s. Never touches your real DBs.

## Prerequisites

- `pg_dump` (from the Postgres client tools; on macOS `brew install libpq && brew link --force libpq`).
- `gpg` (`brew install gnupg`).
- If backing up to S3: `aws` CLI (`brew install awscli`).
- If restoring: `docker` (used by the restore drill to spin up an
  ephemeral Postgres).

## One-off setup

```bash
# 32-byte-ish passphrase; keep out of Git.
export BACKUP_PASSPHRASE=$(openssl rand -base64 32)

# EU-region destination (pick one — S3 in eu-central-1, or a mounted disk).
export BACKUP_DEST="s3://bookpitch-backups-eu/$(date +%Y%m%d)/bookpitch.sql.gpg"
```

## Daily backup

```bash
./scripts/backup-db.sh "$BACKUP_DEST"
```

A GitHub Actions cron is checked in at `.github/workflows/backup.yml`
(daily 02:00 UTC). It needs these repo secrets:

- `DIRECT_URL` — production Postgres URL (no `?schema=` query string).
- `BACKUP_PASSPHRASE` — GPG symmetric passphrase.
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — S3 writer.
- `BACKUP_S3_URI` — e.g. `s3://bookpitch-backups-eu`.

The workflow writes to `${BACKUP_S3_URI}/YYYY/MM/DD/bookpitch-HHMMSS.sql.gpg`
so successive runs never collide.

## Restore drill (do this at least monthly)

```bash
./scripts/restore-db.sh "$BACKUP_DEST"
```

Expected output ends with row counts and a `1` for the
`no_staff_double_booking` constraint. If either the decrypt or the
`psql -v ON_ERROR_STOP=1` step fails, the backup is corrupt — treat
that as an incident.

The GitHub Actions workflow at `.github/workflows/restore-drill.yml`
runs this automatically on the 3rd of each month against the previous
day's S3 backup. A failure fails the workflow (email + red X). Do not
disable this — it's the only proof the backup chain works.

## What the scripts don't do

- **No off-EU copies.** The `verify-eu-residency.sh` script + the
  `.github/workflows/residency-audit.yml` monthly cron catch a
  misconfigured bucket after the fact. For belt-and-braces, add an
  IAM policy on the bucket that only allows `eu-*` regions.
- **No key rotation.** Rotating `BACKUP_PASSPHRASE` means old backups
  become undecryptable — plan for it.
- **No PITR.** These are logical dumps, not WAL archives. If you need
  point-in-time recovery, use the provider's paid tier (Neon PITR,
  Supabase PITR) in addition to this.

## Emergency restore (real incident)

1. Provision a fresh EU-region Postgres.
2. Set `DIRECT_URL` to the new DB.
3. Decrypt + restore with the same script pattern:
   ```bash
   gpg --batch --passphrase "$BACKUP_PASSPHRASE" --decrypt < bookpitch.sql.gpg | psql "$DIRECT_URL"
   ```
4. Re-run `npm run db:migrate` — a pg_dump captures schema, not the
   `_prisma_migrations` table's advisory locks. This is a no-op if the
   dump is current, and a safety belt otherwise.
5. Update the app's `DATABASE_URL` / `DIRECT_URL` / `ADMIN_DATABASE_URL`
   env vars in Vercel and redeploy.
