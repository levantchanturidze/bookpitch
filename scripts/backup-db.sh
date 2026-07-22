#!/usr/bin/env bash
# =============================================================================
# Bookpitch — encrypted database backup.
#
# Runs pg_dump against DIRECT_URL (unpooled, so the dump is consistent),
# encrypts the output with a symmetric GPG passphrase from BACKUP_PASSPHRASE,
# and writes it to $1 (a caller-supplied path — S3-compat, GCS, or a local
# path on an EU-region disk).
#
# EU-residency reminder (ARCHITECTURE §8): the destination MUST live in the
# same EU region as the database. A backup in a US bucket defeats the whole
# point.
#
# Usage:
#   ./scripts/backup-db.sh s3://bookpitch-backups-eu/YYYYmmdd/bookpitch.sql.gpg
#   ./scripts/backup-db.sh /Volumes/backups-eu/bookpitch-$(date +%Y%m%dT%H%M%S).sql.gpg
#
# Env vars required:
#   DIRECT_URL          Postgres connection string (unpooled).
#   BACKUP_PASSPHRASE   Symmetric key for `gpg --symmetric`.
# =============================================================================
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <destination-path>" >&2
  exit 64
fi
DEST="$1"

: "${DIRECT_URL:?DIRECT_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"

command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump not found on PATH" >&2; exit 127; }
command -v gpg     >/dev/null 2>&1 || { echo "gpg not found on PATH" >&2; exit 127; }

TMP="$(mktemp -t bookpitch-backup.XXXXXX.sql.gpg)"
trap 'rm -f "$TMP"' EXIT

# pg_dump rejects Prisma-only query params like `?schema=public`. Strip
# any query string — pg_dump uses the default schema anyway.
DUMP_URL="${DIRECT_URL%%\?*}"

echo "→ pg_dump → gpg symmetric → $TMP" >&2
pg_dump \
  --no-owner --no-privileges --format=plain \
  "$DUMP_URL" \
  | gpg --symmetric --cipher-algo AES256 \
        --batch --passphrase "$BACKUP_PASSPHRASE" \
        --output "$TMP"

BYTES=$(wc -c < "$TMP" | tr -d ' ')
if [[ "$BYTES" -lt 1024 ]]; then
  echo "backup is suspiciously small ($BYTES bytes); refusing to upload" >&2
  exit 1
fi

# Route to the destination. Local path = simple copy; s3://… = aws s3 cp.
case "$DEST" in
  s3://*)
    command -v aws >/dev/null 2>&1 || { echo "aws cli not found" >&2; exit 127; }
    aws s3 cp "$TMP" "$DEST"
    ;;
  gs://*)
    command -v gsutil >/dev/null 2>&1 || { echo "gsutil not found" >&2; exit 127; }
    gsutil cp "$TMP" "$DEST"
    ;;
  *)
    mkdir -p "$(dirname "$DEST")"
    cp "$TMP" "$DEST"
    ;;
esac

echo "✔ backup written: $DEST ($BYTES bytes)" >&2
