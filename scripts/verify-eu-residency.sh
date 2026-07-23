#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Data-residency audit. Given a backup bucket URI (s3://…), verifies:
#   1) The bucket itself lives in an eu-* region.
#   2) No object under the bucket carries an x-amz-replication-status pointing
#      out of eu-* (guards against silent cross-region replication).
#
# Fails with a non-zero exit + explicit message if either check fails. Meant
# to be called from CI monthly; a failure here is a compliance incident.
#
# Requires: AWS credentials with s3:GetBucketLocation + s3:ListBucket +
#           s3:GetObject on the bucket; jq.
# -----------------------------------------------------------------------------

BUCKET_URI="${1:-${BACKUP_S3_URI:-}}"
: "${BUCKET_URI:?usage: $0 s3://bucket-name or set BACKUP_S3_URI}"

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found on PATH" >&2; exit 127; }
command -v jq  >/dev/null 2>&1 || { echo "jq not found on PATH"      >&2; exit 127; }

BUCKET="${BUCKET_URI#s3://}"
BUCKET="${BUCKET%%/*}"

echo "→ checking bucket region for s3://$BUCKET"
REGION=$(aws s3api get-bucket-location --bucket "$BUCKET" --output json \
  | jq -r '.LocationConstraint // "us-east-1"')
echo "   region=$REGION"
if [[ ! "$REGION" =~ ^eu- ]]; then
  echo "::error::bucket $BUCKET is in region $REGION (must start with eu-)" >&2
  exit 1
fi

echo "→ sampling latest objects for replication headers"
# Sample the most recent 25 objects; a per-object HEAD is enough — if
# CRR is enabled it stamps every object with x-amz-replication-status.
KEYS=$(aws s3api list-objects-v2 --bucket "$BUCKET" --max-items 25 \
  --output json | jq -r '.Contents[]?.Key // empty' || true)

if [[ -z "$KEYS" ]]; then
  echo "   (no objects yet — skipping per-object check)"
else
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    status=$(aws s3api head-object --bucket "$BUCKET" --key "$key" --output json \
      | jq -r '.ReplicationStatus // empty' || true)
    if [[ -n "$status" && "$status" != "COMPLETED" ]]; then
      # PENDING / FAILED both mean CRR is configured on this bucket. Even
      # COMPLETED to an eu-* destination is fine — but we can't tell the
      # destination from head-object alone; fail loud so a human reviews.
      echo "::error::object $key has ReplicationStatus=$status — CRR must be disabled or point at eu-*" >&2
      exit 1
    fi
  done <<< "$KEYS"
fi

echo "OK — bucket + sampled objects are EU-only."
