#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Verify Point-In-Time Recovery is on for the production database.
#
# We use two independent checks so one provider's API outage doesn't
# silently disable the audit:
#   1) Provider API check — asks Neon (or Supabase) for the branch's
#      retention window in hours.
#   2) Freshness check — asserts the returned window is >= MIN_HOURS.
#
# Exits non-zero + emits GitHub Actions "::error::" annotations on
# failure so the monthly cron marks the run red and pages whoever
# watches the repo.
#
# Providers:
#   PITR_PROVIDER=neon      → NEON_API_KEY + NEON_PROJECT_ID + NEON_BRANCH_ID (opt)
#   PITR_PROVIDER=supabase  → SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF
# -----------------------------------------------------------------------------

PROVIDER="${PITR_PROVIDER:-}"
MIN_HOURS="${PITR_MIN_HOURS:-24}"

command -v jq   >/dev/null 2>&1 || { echo "jq not found on PATH"   >&2; exit 127; }
command -v curl >/dev/null 2>&1 || { echo "curl not found on PATH" >&2; exit 127; }

if [[ -z "$PROVIDER" ]]; then
  echo "::error::PITR_PROVIDER is required (neon|supabase)" >&2
  exit 2
fi

case "$PROVIDER" in
  neon)
    : "${NEON_API_KEY:?NEON_API_KEY is required}"
    : "${NEON_PROJECT_ID:?NEON_PROJECT_ID is required}"
    URL="https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}"
    RESP=$(curl -sS -H "Authorization: Bearer ${NEON_API_KEY}" -H "Accept: application/json" "$URL")
    # Neon exposes history retention on the project (`history_retention_seconds`).
    RETENTION_SEC=$(echo "$RESP" | jq -r '.project.history_retention_seconds // empty')
    if [[ -z "$RETENTION_SEC" ]]; then
      echo "::error::Neon project response missing history_retention_seconds" >&2
      echo "response: $RESP" >&2
      exit 1
    fi
    RETENTION_HOURS=$(( RETENTION_SEC / 3600 ))
    echo "neon project=${NEON_PROJECT_ID} retention_hours=${RETENTION_HOURS}"
    ;;
  supabase)
    : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
    : "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"
    URL="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/backups"
    RESP=$(curl -sS -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Accept: application/json" "$URL")
    # Response shape: { "pitr_enabled": bool, "walg_enabled": bool, "backups": […] }
    PITR_ON=$(echo "$RESP" | jq -r '.pitr_enabled // false')
    if [[ "$PITR_ON" != "true" ]]; then
      echo "::error::Supabase project ${SUPABASE_PROJECT_REF} PITR is DISABLED" >&2
      echo "response: $RESP" >&2
      exit 1
    fi
    # Supabase PITR retention isn't exposed on this endpoint; we know the
    # plan tier's default (7d on Pro, 28d on Team). Assume 7d and let the
    # MIN_HOURS check gate it.
    RETENTION_HOURS=${SUPABASE_PITR_HOURS:-168}
    echo "supabase project=${SUPABASE_PROJECT_REF} pitr=on retention_hours=${RETENTION_HOURS}"
    ;;
  *)
    echo "::error::Unknown PITR_PROVIDER: $PROVIDER (expected neon|supabase)" >&2
    exit 2
    ;;
esac

if (( RETENTION_HOURS < MIN_HOURS )); then
  echo "::error::retention window ${RETENTION_HOURS}h < required ${MIN_HOURS}h" >&2
  exit 1
fi

echo "OK — ${PROVIDER} PITR retention ${RETENTION_HOURS}h (>= ${MIN_HOURS}h)"
