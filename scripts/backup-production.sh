#!/usr/bin/env bash
#
# Production logical backup — dump, verify, encrypt.
#
# Supabase Free has no automated backups and no PITR (both are paid tiers), so
# this script IS the recovery point. It runs from
# .github/workflows/production-backup.yml once a day and can be run by hand.
#
# Contract
#   in : BACKUP_DATABASE_URL   connection URL, read from the environment ONLY
#        BACKUP_AGE_RECIPIENT  optional; defaults to ops/backup-age-recipient.txt
#        $1                    output directory (created if absent)
#   out : $1/<name>.tar.age    encrypted bundle — the only file that may be kept
#         $1/<name>.tar.age.sha256
#         $1/manifest.json
#
# Guarantees, in the order they matter:
#   1. The connection URL never reaches argv, stdout, stderr or a file name.
#      pg-conn-env.py turns it into PG* env vars + a 0600 .pgpass.
#   2. Plaintext never survives the process. The work directory is created
#      under a 0700 parent and removed by an EXIT trap that fires on success,
#      failure and signal alike.
#   3. The dump is validated with `pg_restore --list` BEFORE encryption. An
#      archive that pg_restore cannot read is not a backup.
#   4. Nothing is written to the output directory until validation passed, so a
#      failed run cannot leave a plausible-looking but unusable artifact.
#
set -euo pipefail

OUT_DIR="${1:-}"
if [ -z "$OUT_DIR" ]; then
  echo "usage: $0 <output-directory>" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECIPIENT_FILE="${BACKUP_AGE_RECIPIENT_FILE:-$REPO_ROOT/ops/backup-age-recipient.txt}"

# ---------------------------------------------------------------------------
# Ephemeral work directory. Everything plaintext lives here and only here.
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bookpitch-backup.XXXXXXXX")"
chmod 700 "$WORK_DIR"

cleanup() {
  local status=$?
  # Overwrite before unlinking where the tool exists; `rm -rf` alone is enough
  # on an ephemeral runner but this costs nothing on a developer laptop.
  if [ -d "$WORK_DIR" ]; then
    find "$WORK_DIR" -type f -exec dd if=/dev/zero of={} bs=1024 count=1 conv=notrunc status=none \; 2>/dev/null || true
    rm -rf "$WORK_DIR"
  fi
  return $status
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Recipient (public key). Refuse to run without one — an unencrypted dump of a
# clinical database is the exact outcome this whole file exists to prevent.
# ---------------------------------------------------------------------------
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
if [ -z "$RECIPIENT" ]; then
  if [ ! -f "$RECIPIENT_FILE" ]; then
    echo "FATAL: no age recipient: $RECIPIENT_FILE missing and BACKUP_AGE_RECIPIENT unset" >&2
    exit 3
  fi
  RECIPIENT="$(grep -v '^[[:space:]]*#' "$RECIPIENT_FILE" | grep -v '^[[:space:]]*$' | head -n1 | tr -d '[:space:]')"
fi
case "$RECIPIENT" in
  age1*) : ;;
  *) echo "FATAL: age recipient does not look like an age public key" >&2; exit 3 ;;
esac
echo "→ encrypting to recipient ${RECIPIENT:0:12}… (public key, truncated)"

# ---------------------------------------------------------------------------
# Connection environment. From here on the URL exists only as PG* vars.
# ---------------------------------------------------------------------------
PGPASS_FILE="$WORK_DIR/pgpass"
eval "$(python3 "$REPO_ROOT/scripts/pg-conn-env.py" "$PGPASS_FILE")"
unset BACKUP_DATABASE_URL

PG_DUMP="${PG_DUMP_BIN:-pg_dump}"
PG_DUMPALL="${PG_DUMPALL_BIN:-pg_dumpall}"
PG_RESTORE="${PG_RESTORE_BIN:-pg_restore}"
PSQL="${PSQL_BIN:-psql}"

# `pg_dump --version` prints e.g. "pg_dump (PostgreSQL) 17.11 (Homebrew)" —
# the last field is not the version on every build. Take the first
# version-shaped token instead.
CLIENT_VERSION="$("$PG_DUMP" --version | grep -oE '[0-9]+(\.[0-9]+)*' | head -n1)"
SERVER_VERSION="$("$PSQL" -tAX -c 'SHOW server_version' | tr -d '[:space:]')"
echo "→ pg_dump ${CLIENT_VERSION} against server ${SERVER_VERSION}"

# pg_dump refuses to dump from a server newer than itself. Catch that here with
# a readable message instead of a wall of libpq output half an hour into a cron.
CLIENT_MAJOR="${CLIENT_VERSION%%.*}"
SERVER_MAJOR="${SERVER_VERSION%%.*}"
if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  echo "FATAL: pg_dump ${CLIENT_VERSION} cannot dump a PostgreSQL ${SERVER_VERSION} server. Install postgresql-client-${SERVER_MAJOR}." >&2
  exit 4
fi

# Sanitised production identity: proves two backups came from the same database
# without disclosing the host, the project ref, or the database name.
IDENTITY_FINGERPRINT="$(printf '%s:%s/%s' "$PGHOST" "$PGPORT" "$PGDATABASE" \
  | shasum -a 256 2>/dev/null | awk '{print $1}' || printf '%s:%s/%s' "$PGHOST" "$PGPORT" "$PGDATABASE" | sha256sum | awk '{print $1}')"
IDENTITY_FINGERPRINT="${IDENTITY_FINGERPRINT:0:16}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Collision-resistant even if two runs start in the same second: the caller
# supplies a unique suffix in CI (run id + attempt); locally we fall back to
# the PID, which cannot repeat within a second on the same machine.
UNIQUE_SUFFIX="${BACKUP_NAME_SUFFIX:-local-$$}"
BASENAME="bookpitch-prod-${TIMESTAMP}-${UNIQUE_SUFFIX}"

DUMP_FILE="$WORK_DIR/database.dump"
GLOBALS_FILE="$WORK_DIR/globals.sql"
LIST_FILE="$WORK_DIR/pg_restore-list.txt"
BUNDLE_FILE="$WORK_DIR/bundle.tar"

# ---------------------------------------------------------------------------
# 1. Custom-format dump of the application schema, schema + data.
# ---------------------------------------------------------------------------
BACKUP_SCHEMA="${BACKUP_SCHEMA:-public}"
echo "→ dumping schema '${BACKUP_SCHEMA}' (custom format, compressed)"
"$PG_DUMP" \
  --format=custom \
  --compress=9 \
  --schema="$BACKUP_SCHEMA" \
  --no-password \
  --verbose \
  --file="$DUMP_FILE" \
  2> "$WORK_DIR/pg_dump.log" || {
    echo "FATAL: pg_dump failed. Tail of its log (URL-free):" >&2
    # --verbose output is object names only; it never contains the URL, but
    # scrub anything URL-shaped defensively before it reaches a CI log.
    sed -E 's#postgres(ql)?://[^[:space:]"]+#[REDACTED-DB-URL]#g' "$WORK_DIR/pg_dump.log" | tail -n 25 >&2
    exit 5
  }

DUMP_BYTES="$(wc -c < "$DUMP_FILE" | tr -d '[:space:]')"
echo "→ dump written: ${DUMP_BYTES} bytes"
if [ "$DUMP_BYTES" -lt 1024 ]; then
  echo "FATAL: dump is implausibly small (${DUMP_BYTES} bytes) — refusing to publish it" >&2
  exit 5
fi

# ---------------------------------------------------------------------------
# 2. Roles and grants, separately, without role passwords.
#    Managed Postgres often refuses pg_dumpall to a non-superuser. That is a
#    known-and-recorded outcome, not a silent one: the status lands in the
#    manifest and is printed here.
# ---------------------------------------------------------------------------
GLOBALS_STATUS="ok"
echo "→ dumping globals (roles + grants, no passwords)"
if "$PG_DUMPALL" --globals-only --no-role-passwords --no-password \
     > "$GLOBALS_FILE" 2> "$WORK_DIR/pg_dumpall.log"; then
  GLOBALS_BYTES="$(wc -c < "$GLOBALS_FILE" | tr -d '[:space:]')"
  echo "→ globals written: ${GLOBALS_BYTES} bytes"
  if grep -qiE '^[[:space:]]*(CREATE ROLE|ALTER ROLE)' "$GLOBALS_FILE"; then
    # Belt and braces: --no-role-passwords should make this impossible, but a
    # dump that leaked a role password must never be shipped, even encrypted.
    if grep -qiE "PASSWORD '" "$GLOBALS_FILE"; then
      echo "FATAL: globals dump contains a role password despite --no-role-passwords" >&2
      exit 6
    fi
  else
    GLOBALS_STATUS="empty"
  fi
else
  GLOBALS_STATUS="unsupported"
  echo "WARNING: pg_dumpall --globals-only is not permitted for this role." >&2
  sed -E 's#postgres(ql)?://[^[:space:]"]+#[REDACTED-DB-URL]#g' "$WORK_DIR/pg_dumpall.log" | tail -n 5 >&2
  echo "WARNING: continuing — role definitions are reproducible from prisma/migrations." >&2
  : > "$GLOBALS_FILE"
fi

# ---------------------------------------------------------------------------
# 3. Validate the archive before it is encrypted. An unreadable dump is not a
#    backup, and finding that out during an incident is too late.
# ---------------------------------------------------------------------------
echo "→ validating archive with pg_restore --list"
"$PG_RESTORE" --list "$DUMP_FILE" > "$LIST_FILE"
TOC_ENTRIES="$(grep -cvE '^(;|$)' "$LIST_FILE" || true)"
echo "→ archive table of contents: ${TOC_ENTRIES} entries"
if [ "${TOC_ENTRIES:-0}" -lt 20 ]; then
  echo "FATAL: archive has only ${TOC_ENTRIES} restorable entries — refusing to publish it" >&2
  exit 7
fi
# The application must actually be in there. These three are load-bearing:
# the migration ledger, the tenant root, and the append-only audit log.
for required in _prisma_migrations organizations audit_log; do
  if ! grep -q "TABLE .*${required}" "$LIST_FILE"; then
    echo "FATAL: archive does not contain table '${required}'" >&2
    exit 7
  fi
done
VERIFICATION_STATUS="pg_restore-list-ok"

# ---------------------------------------------------------------------------
# 4. Bundle, then encrypt. Plaintext never leaves $WORK_DIR.
# ---------------------------------------------------------------------------
echo "→ bundling"
tar -C "$WORK_DIR" -cf "$BUNDLE_FILE" \
  "$(basename "$DUMP_FILE")" "$(basename "$GLOBALS_FILE")" "$(basename "$LIST_FILE")"

mkdir -p "$OUT_DIR"
ENCRYPTED_FILE="$OUT_DIR/${BASENAME}.tar.age"

echo "→ encrypting with age"
age --encrypt --recipient "$RECIPIENT" --output "$ENCRYPTED_FILE" "$BUNDLE_FILE"

# age writes a binary header starting with "age-encryption.org/v1". If this is
# not present the file is not encrypted and must not survive.
if ! head -c 21 "$ENCRYPTED_FILE" | grep -q 'age-encryption.org'; then
  echo "FATAL: output is not an age file — deleting it" >&2
  rm -f "$ENCRYPTED_FILE"
  exit 8
fi

ENCRYPTED_BYTES="$(wc -c < "$ENCRYPTED_FILE" | tr -d '[:space:]')"
if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="$(sha256sum "$ENCRYPTED_FILE" | awk '{print $1}')"
else
  CHECKSUM="$(shasum -a 256 "$ENCRYPTED_FILE" | awk '{print $1}')"
fi
printf '%s  %s\n' "$CHECKSUM" "${BASENAME}.tar.age" > "$ENCRYPTED_FILE.sha256"

# ---------------------------------------------------------------------------
# 5. Manifest. Operational metadata only — no host, no user, no database name,
#    no row counts, no tenant identifiers.
# ---------------------------------------------------------------------------
cat > "$OUT_DIR/manifest.json" <<JSON
{
  "artifact": "${BASENAME}.tar.age",
  "created_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pg_client_version": "${CLIENT_VERSION}",
  "pg_server_version": "${SERVER_VERSION}",
  "encrypted_bytes": ${ENCRYPTED_BYTES},
  "sha256": "${CHECKSUM}",
  "production_identity_fingerprint": "${IDENTITY_FINGERPRINT}",
  "schema": "${BACKUP_SCHEMA}",
  "toc_entries": ${TOC_ENTRIES},
  "globals_status": "${GLOBALS_STATUS}",
  "verification_status": "${VERIFICATION_STATUS}",
  "encryption": "age/x25519",
  "recipient_prefix": "${RECIPIENT:0:12}"
}
JSON

echo "→ backup complete"
echo "   artifact : ${BASENAME}.tar.age"
echo "   bytes    : ${ENCRYPTED_BYTES}"
echo "   sha256   : ${CHECKSUM}"
echo "   globals  : ${GLOBALS_STATUS}"

# Emit the artifact name for the workflow without ever emitting a path that
# could contain a credential.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "artifact_name=${BASENAME}"
    echo "sha256=${CHECKSUM}"
    echo "encrypted_bytes=${ENCRYPTED_BYTES}"
  } >> "$GITHUB_OUTPUT"
fi
