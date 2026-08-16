# Database backup & restore

**This document was replaced on 2026-08-16 (Phase 13).** The authoritative
runbook is [`docs/operations.md`](./operations.md) — §4 backups, §5 key custody,
§6 restore, §11 RTO/RPO.

## What changed, and why it matters

The previous design dumped with `pg_dump`, encrypted with GPG symmetric
AES-256, and pushed to an `eu-central-1` S3 bucket on a nightly cron, with a
monthly restore drill and two compliance audits layered on top. On paper it was
the stronger design: EU-resident, PITR-aware, residency-audited.

It never worked. `backup.yml`, `restore-drill.yml`, `residency-audit.yml` and
`pitr-audit.yml` all referenced repository secrets that had never been created
(`DIRECT_URL`, `BACKUP_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`BACKUP_S3_URI`). Every scheduled run failed, every night, from the day they
were merged until 2026-08-16. **Not one backup was ever produced**, and the
`pitr-audit` workflow could never have passed at all: PITR is a Supabase Pro
feature and this project is on Free.

That is the same failure this project has hit before, and it is why CLAUDE.md
says a control that does not change observable behaviour does not exist. Here
the signal was not even green — it was red, nightly, and nobody was listening.

## What replaced it

| Old | New |
| --- | --- |
| `.github/workflows/backup.yml` (S3 + GPG) | `.github/workflows/production-backup.yml` (artifact + `age`) |
| `.github/workflows/restore-drill.yml` (S3, docker) | `.github/workflows/restore-drill.yml` (artifact, service container) |
| `scripts/backup-db.sh`, `scripts/restore-db.sh` | `scripts/backup-production.sh`, `scripts/restore-drill.sh`, `scripts/restore-verify.sql` |
| `residency-audit.yml`, `verify-eu-residency.sh` | removed — there is no S3 bucket; the residency trade-off is documented in `operations.md` §4 |
| `pitr-audit.yml`, `verify-pitr.sh` | removed — PITR requires Supabase Pro; RPO is stated honestly in `operations.md` §11 |
| nothing verified the backup | every backup is decrypted and `pg_restore --list`-checked the day it is taken, by a job that does not hold the database credential |

The new system uses secrets that exist, runs on a schedule that fires, and its
first manual run is recorded in `docs/phase-13-production-reliability-ledger.md`
with the artifact checksum and the restore-drill result.

## The one thing that got weaker

Backups are now GitHub Actions artifacts rather than EU-region object storage,
so the ciphertext may rest outside the EU. It is encrypted client-side with
`age`/X25519 before it leaves the runner and GitHub never holds the private key.
Restoring EU residency needs an object store or a Supabase Pro upgrade — both
spending decisions. See `operations.md` §4.
