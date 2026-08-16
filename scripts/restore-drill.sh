#!/usr/bin/env bash
#
# Restore drill — decrypt a production backup into a throwaway database and
# prove the invariants survived.
#
# A backup nobody has restored is a hypothesis. This script is what turns it
# into a fact, so it is deliberately unforgiving: any failure anywhere fails the
# run, nothing is retried, nothing is `|| true`-ed.
#
# Contract
#   in : $1                          path to the encrypted .tar.age bundle
#        $2                          path to its .sha256 file (optional; if the
#                                    file sits next to the bundle it is found)
#        RESTORE_TARGET_URL          disposable database — allow-listed hosts only
#        RESTORE_AGE_IDENTITY_FILE   age private key file (0400)
#   out : exit 0 only when the archive decrypted, restored and passed
#         scripts/restore-verify.sql
#
set -euo pipefail

BUNDLE="${1:-}"
CHECKSUM_FILE="${2:-}"
if [ -z "$BUNDLE" ]; then
  echo "usage: $0 <encrypted-bundle.tar.age> [checksum-file]" >&2
  exit 64
fi
if [ ! -f "$BUNDLE" ]; then
  echo "FATAL: bundle not found: $BUNDLE" >&2
  exit 64
fi
if [ -z "$CHECKSUM_FILE" ] && [ -f "$BUNDLE.sha256" ]; then
  CHECKSUM_FILE="$BUNDLE.sha256"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bookpitch-restore.XXXXXXXX")"
chmod 700 "$WORK_DIR"
cleanup() {
  local status=$?
  if [ -d "$WORK_DIR" ]; then
    find "$WORK_DIR" -type f -exec dd if=/dev/zero of={} bs=1024 count=1 conv=notrunc status=none \; 2>/dev/null || true
    rm -rf "$WORK_DIR"
  fi
  return $status
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 0. The target must be disposable. Checked BEFORE anything is decrypted, so a
#    misconfigured run never even materialises plaintext.
# ---------------------------------------------------------------------------
echo "→ verifying the restore target is disposable"
python3 "$REPO_ROOT/scripts/assert-disposable-db.py" --env-var RESTORE_TARGET_URL

# ---------------------------------------------------------------------------
# 1. Checksum. Proves the artifact that comes back out of storage is the one
#    that went in.
# ---------------------------------------------------------------------------
if [ -n "$CHECKSUM_FILE" ] && [ -f "$CHECKSUM_FILE" ]; then
  echo "→ verifying checksum"
  EXPECTED="$(awk '{print $1}' < "$CHECKSUM_FILE")"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$BUNDLE" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "FATAL: checksum mismatch — expected ${EXPECTED}, got ${ACTUAL}" >&2
    exit 9
  fi
  echo "→ checksum ok: ${ACTUAL}"
else
  echo "FATAL: no checksum file for ${BUNDLE##*/} — refusing to restore an unverified artifact" >&2
  exit 9
fi

# ---------------------------------------------------------------------------
# 2. Decrypt, inside the ephemeral work directory only.
# ---------------------------------------------------------------------------
IDENTITY_FILE="${RESTORE_AGE_IDENTITY_FILE:-}"
if [ -z "$IDENTITY_FILE" ] || [ ! -f "$IDENTITY_FILE" ]; then
  echo "FATAL: RESTORE_AGE_IDENTITY_FILE is unset or does not point at a file" >&2
  exit 10
fi

echo "→ decrypting"
age --decrypt --identity "$IDENTITY_FILE" --output "$WORK_DIR/bundle.tar" "$BUNDLE"
tar -C "$WORK_DIR" -xf "$WORK_DIR/bundle.tar"
rm -f "$WORK_DIR/bundle.tar"

DUMP_FILE="$WORK_DIR/database.dump"
GLOBALS_FILE="$WORK_DIR/globals.sql"
if [ ! -f "$DUMP_FILE" ]; then
  echo "FATAL: decrypted bundle has no database.dump" >&2
  exit 10
fi
echo "→ decrypted dump: $(wc -c < "$DUMP_FILE" | tr -d '[:space:]') bytes"

# ---------------------------------------------------------------------------
# 3. The archive must be readable before we try to restore it.
# ---------------------------------------------------------------------------
PG_RESTORE="${PG_RESTORE_BIN:-pg_restore}"
PSQL="${PSQL_BIN:-psql}"

echo "→ pg_restore --list"
"$PG_RESTORE" --list "$DUMP_FILE" > "$WORK_DIR/toc.txt"
echo "→ table of contents: $(grep -cvE '^(;|$)' "$WORK_DIR/toc.txt") entries"

# Role/grant capture is verified by inspection rather than execution: the
# disposable container has a different role set, and executing a managed
# provider's globals there would fail for reasons that say nothing about our
# backup. What matters is that the definitions were captured.
if [ -s "$GLOBALS_FILE" ]; then
  if grep -qE '^[[:space:]]*CREATE ROLE[[:space:]]+bookpitch_app' "$GLOBALS_FILE"; then
    echo "→ globals: bookpitch_app role definition captured"
  else
    echo "FATAL: globals dump does not define the bookpitch_app runtime role" >&2
    exit 11
  fi
  if grep -qE "PASSWORD '" "$GLOBALS_FILE"; then
    echo "FATAL: globals dump contains a role password" >&2
    exit 11
  fi
else
  echo "→ globals: not captured for this backup (see manifest globals_status)"
fi

# ---------------------------------------------------------------------------
# 4. Connection environment for the disposable target.
# ---------------------------------------------------------------------------
PGPASS_FILE="$WORK_DIR/pgpass"
eval "$(python3 "$REPO_ROOT/scripts/pg-conn-env.py" "$PGPASS_FILE" --env-var RESTORE_TARGET_URL)"
unset RESTORE_TARGET_URL

echo "→ restoring into ${PGDATABASE} on ${PGHOST}:${PGPORT}"

# Restoring on top of an existing dataset would make every assertion below
# meaningless. Require a genuinely empty target.
EXISTING_TABLES="$("$PSQL" -tAX -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]')"
if [ "${EXISTING_TABLES:-0}" -ne 0 ]; then
  echo "FATAL: target already has ${EXISTING_TABLES} tables in public — the drill needs an empty database" >&2
  exit 12
fi

# The dump is scoped to `public`, and pg_dump does not carry extension objects
# in a schema-scoped dump. btree_gist and citext live in `public` in production
# and are referenced by column types and exclusion constraints, so they must
# exist before the restore starts. pgcrypto lives in Supabase's `extensions`
# schema; it is created here too so any incidental call site resolves.
"$PSQL" -v ON_ERROR_STOP=1 -X -q -c 'CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;'
"$PSQL" -v ON_ERROR_STOP=1 -X -q -c 'CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;'
"$PSQL" -v ON_ERROR_STOP=1 -X -q -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;'

# A schema-scoped dump carries a `CREATE SCHEMA public` entry, which collides
# with the one every database is born with. Rather than restore with errors
# ignored — which would hide real failures — drop exactly that one TOC entry and
# assert that exactly one entry was dropped. Everything else stays under
# --exit-on-error.
"$PG_RESTORE" --list "$DUMP_FILE" > "$WORK_DIR/toc-full.txt"
grep -v ' SCHEMA - public ' "$WORK_DIR/toc-full.txt" > "$WORK_DIR/toc-use.txt"
DROPPED=$(( $(grep -cvE '^(;|$)' "$WORK_DIR/toc-full.txt") - $(grep -cvE '^(;|$)' "$WORK_DIR/toc-use.txt") ))
if [ "$DROPPED" -ne 1 ]; then
  echo "FATAL: expected to skip exactly 1 TOC entry (CREATE SCHEMA public), skipped ${DROPPED}" >&2
  exit 12
fi
echo "→ skipping 1 TOC entry: CREATE SCHEMA public (target already has it)"

# --exit-on-error: a partial restore that "mostly worked" is the failure mode
# this whole drill exists to catch. --no-owner/--no-privileges because the
# throwaway server does not have the managed provider's role set; grants are
# verified from globals.sql above instead.
set +e
"$PG_RESTORE" \
  --dbname="$PGDATABASE" \
  --use-list="$WORK_DIR/toc-use.txt" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --verbose \
  "$DUMP_FILE" > "$WORK_DIR/pg_restore.log" 2>&1
RESTORE_STATUS=$?
set -e

if [ $RESTORE_STATUS -ne 0 ]; then
  echo "FATAL: pg_restore exited ${RESTORE_STATUS}. Last 40 lines:" >&2
  sed -E 's#postgres(ql)?://[^[:space:]"]+#[REDACTED-DB-URL]#g' "$WORK_DIR/pg_restore.log" | tail -n 40 >&2
  exit 12
fi

# --exit-on-error covers hard failures. Scan the log too: a run that printed
# errors but still exited 0 is exactly the "suppressed error" case requirement
# 10 of the drill asks about.
if grep -qE '^pg_restore: (error|warning): ' "$WORK_DIR/pg_restore.log"; then
  echo "FATAL: pg_restore reported errors/warnings despite exiting 0:" >&2
  grep -E '^pg_restore: (error|warning): ' "$WORK_DIR/pg_restore.log" | head -n 20 >&2
  exit 12
fi
echo "→ pg_restore completed with no errors"

# ---------------------------------------------------------------------------
# 5. Invariants. Counts and catalog only — no restored customer data printed.
# ---------------------------------------------------------------------------
echo "→ verifying restored invariants"
"$PSQL" -v ON_ERROR_STOP=1 -X -f "$REPO_ROOT/scripts/restore-verify.sql"

echo
echo "RESTORE DRILL PASSED — the encrypted production backup is recoverable."
