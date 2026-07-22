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

Wire it to a schedule you control — GitHub Actions cron, systemd
timer, Vercel cron hitting a small handler that shells out. The
destination filename should include the date so successive backups
don't overwrite each other.

## Restore drill (do this at least monthly)

```bash
./scripts/restore-db.sh "$BACKUP_DEST"
```

Expected output ends with row counts and a `1` for the
`no_staff_double_booking` constraint. If either the decrypt or the
`psql -v ON_ERROR_STOP=1` step fails, the backup is corrupt — treat
that as an incident.

## What the scripts don't do

- **No off-EU copies.** If you point `--destination` at a US bucket the
  script will happily upload; the residency guard is you reading this
  section. Consider adding an IAM policy on the bucket that only allows
  `eu-*` regions.
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
