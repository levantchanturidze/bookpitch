#!/usr/bin/env bash
# =============================================================================
# Bookpitch — restore drill.
#
# Takes a GPG-encrypted pg_dump (from backup-db.sh), spins up a fresh temp
# Postgres via docker compose, restores into it, and runs sanity SELECTs to
# confirm the row counts look right. Non-destructive to your real DBs — it
# NEVER writes to DIRECT_URL / DATABASE_URL. The whole point is to prove
# the backup opens cleanly before an emergency.
#
# Usage:
#   ./scripts/restore-db.sh path/to/bookpitch.sql.gpg
#   BACKUP_PASSPHRASE=... ./scripts/restore-db.sh s3://bookpitch-backups-eu/…/bookpitch.sql.gpg
# =============================================================================
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <backup-source>" >&2
  exit 64
fi
SRC="$1"

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 127; }
command -v gpg    >/dev/null 2>&1 || { echo "gpg not found on PATH" >&2; exit 127; }

TMP_ENC="$(mktemp -t bookpitch-restore.XXXXXX.sql.gpg)"
TMP_SQL="$(mktemp -t bookpitch-restore.XXXXXX.sql)"
CONTAINER="bookpitch-restore-drill"
trap 'rm -f "$TMP_ENC" "$TMP_SQL"; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

# 1. Fetch the encrypted dump.
case "$SRC" in
  s3://*) command -v aws    >/dev/null || { echo "aws cli not found"    >&2; exit 127; }; aws s3 cp "$SRC" "$TMP_ENC" ;;
  gs://*) command -v gsutil >/dev/null || { echo "gsutil not found"     >&2; exit 127; }; gsutil cp "$SRC" "$TMP_ENC" ;;
  *)      cp "$SRC" "$TMP_ENC" ;;
esac

# 2. Decrypt.
gpg --batch --passphrase "$BACKUP_PASSPHRASE" --decrypt --output "$TMP_SQL" "$TMP_ENC"

# 3. Spin up an ephemeral Postgres for the drill (bound to a random port).
echo "→ starting ephemeral postgres…" >&2
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
CID=$(docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_USER=drill -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill \
  -p 55432:5432 postgres:16-alpine)
# Wait for readiness.
for i in {1..20}; do
  if docker exec "$CID" pg_isready -U drill >/dev/null 2>&1; then break; fi
  sleep 1
done

RESTORE_URL="postgresql://drill:drill@localhost:55432/drill?sslmode=disable"

# 4. Restore.
echo "→ restoring $(wc -c < "$TMP_SQL" | tr -d ' ') bytes into ephemeral DB…" >&2
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -q -f "$TMP_SQL" >/dev/null

# 5. Sanity checks.
echo "→ sanity checks:" >&2
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 <<'SQL'
\pset border 1
SELECT 'organizations'::text AS table, COUNT(*) FROM organizations
UNION ALL SELECT 'customers',    COUNT(*) FROM customers
UNION ALL SELECT 'appointments', COUNT(*) FROM appointments
UNION ALL SELECT 'payments',     COUNT(*) FROM payments;
SELECT COUNT(*) AS "no_staff_double_booking_present"
  FROM pg_constraint WHERE conname = 'no_staff_double_booking';
SQL

echo "✔ restore drill passed" >&2
