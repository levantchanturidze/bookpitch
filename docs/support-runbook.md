# Support runbook

Operational procedures for running Bookpitch in a pilot. Written for one
operator, because that is what exists (`docs/phase-15-risk-register.md` R-11).

Related, not duplicated here: `docs/operations.md` (environment and required
config), `docs/backup.md` (backup and restore mechanics),
`docs/rbac-migration-runbook.md` (permission changes).

## 1. Incident intake

There is no ticketing system and no status page. Incidents arrive by exactly
three routes:

1. **Automated** — the production monitor runs every ~30 minutes
   (`.github/workflows/production-monitor.yml`, 18 checks) and opens or updates
   a GitHub issue assigned to the repository owner on failure.
2. **Migration failure** — `.github/workflows/migrate.yml` opens an assigned
   issue on failure.
3. **Human report** — a pilot organisation contacts the operator directly.

GitHub only pushes notifications for assignments and mentions, which is why
both workflows assign the owner rather than merely labelling.

## 2. Severity

| Sev | Meaning | Examples | Response |
|---|---|---|---|
| **S1** | Data loss, data exposure, or total outage | Cross-tenant leak, database down, auth bypass | Immediately; consider taking the service offline |
| **S2** | A launch-critical journey is broken for everyone | Signup fails, no verification email, cannot book | Same day |
| **S3** | Degraded or broken for some users, workaround exists | One role's page errors, reminders delayed | Next working day |
| **S4** | Cosmetic or minor | Layout defect, wording | Next batch |

Escalate any suspected cross-tenant data access to S1 on suspicion. Do not
wait for confirmation — confirming it takes longer than containing it.

## 3. Escalation

Single operator. The escalation path is honest about that:

1. Operator triages.
2. If it is S1 and the operator cannot act, the only available lever is to
   reduce exposure: suspend the affected organisation, or take the deployment
   offline. Both are preferable to an unattended S1.
3. There is **no second responder**. Do not write one into a process document
   and assume they exist.

Provider-side outages (Vercel, Supabase, Resend, Cloudflare) are not fixable
locally. Confirm on the provider status page, record the incident, and
communicate — do not attempt a workaround that bypasses a security control.

## 4. Diagnosis order

Work outside in; each step is cheap and rules out a layer.

1. `curl -s https://bookpitch.ge/api/health` → expect exactly `{"ok":true}`.
2. Latest **Production monitor** run — which of the 18 checks failed, and its
   detail line.
3. Vercel deployment state: is the current production deployment `Ready`, and
   does it correspond to the merged SHA?
4. Vercel runtime logs for 5xx.
5. `npx prisma migrate status` against production — schema behind code?
6. `/api/health/ops` (bearer `CRON_SECRET`) for outbox, housekeeping,
   retention, partition and config counts.

## 5. Common problems

### "I never got my verification email"

By far the most likely report during the pilot, and today the most likely to be
a real platform fault rather than user error.

1. **Check the known blocker first.** `docs/email-dns-readiness.md`: the
   sending domain has no DKIM/SPF. Until that is fixed, assume the platform is
   at fault.
2. Ask them to check spam.
3. Check outbox state via `/api/health/ops`: `pending` climbing means the drain
   is stuck; `dead` non-zero means delivery failed permanently.
4. Resend is available from the pending page and supersedes the previous
   token. It is rate limited to one per 5 minutes and is enumeration-safe, so
   it returns the same response whether or not the address exists — that is
   deliberate and not a bug to work around.

### "I can't sign in"

- Sign-in errors are deliberately generic and reveal nothing about whether an
  account exists. Do not read a specific cause from the message.
- Administrators **cannot** set a password — invariant 6. Send a reset link.
- If they recently had a role or permission change, their session may have been
  invalidated by a session-version bump. Signing in again is the fix.

### "The page says Access Locked"

Working as intended: the role lacks the permission for that surface. Check the
role's permissions in `/settings/permissions`. Do not grant a broader role to
clear the message — that is a privilege escalation dressed as support.

### "My appointment reminder never arrived"

1. Reminders run every 15 minutes (`*/15` in `.github/workflows/cron.yml`);
   check recent runs succeeded.
2. Check the outbox counters as above.
3. Confirm the appointment is inside the reminder window and the customer has a
   contact address recorded.

### "The weekly audit digest stopped"

Known: R-08. The weekly GitHub schedule can be dropped entirely. The monitor
now fails when a digest has been due longer than the window. Trigger manually
with a `workflow_dispatch` on **Scheduled crons**.

## 6. Data requests

- **Export** — an organisation can export a single customer's data from the
  privacy tooling. It decrypts allergies and clinical notes, so treat the
  output as the most sensitive artefact the system produces. Never email it
  unencrypted.
- **Erasure** — redaction in place, not row deletion. Read the limits in
  `/privacy` before promising anything: audit-log entries are append-only and
  survive; treatment history currently survives (R-13, undecided).
- **Never** run manual SQL against production to satisfy a request. Use the
  product's tooling so the action is audited.

## 7. Rollback vs forward fix

Prefer forward fix. Roll back when the current state is actively harmful and a
fix is not minutes away.

**Rollback is safe when** the change was code-only.
Promote the previous known-good Vercel deployment.

**Rollback is NOT safe when** the release included a migration. Migrations are
expand-only by invariant, so old code tolerates the new schema — but the
reverse is not guaranteed, and a restore is not a rollback. If a migration is
implicated, forward-fix.

**Never** restore a backup into production to undo a deploy. That trades a code
defect for up to 24 hours of data loss (R-09).

## 8. Security incident

1. Contain first: suspend the affected organisation or take the deployment
   offline. Availability is worth less than containment.
2. **Do not** delete or edit audit-log entries. They are append-only in the
   database and are the evidence.
3. Preserve the monitor issue, Vercel logs and the deployment ID.
4. Rotate credentials only per the process in `CLAUDE.md` § Secret handling —
   note Supabase's dashboard reset rotates only the `postgres` role, and
   `bookpitch_app` needs a separate `ALTER USER`.
5. Never paste a credential, token or connection string into an issue.

## 9. Offboarding an organisation

1. Export anything they are entitled to take.
2. Suspend rather than delete first — reversible, and preserves the audit
   trail.
3. Redact customer records through the privacy tooling so the erasure is
   audited.
4. Delete only after the retention question in
   `docs/legal-review-checklist.md` is answered.

## 10. Known limitations

Do not promise around these; they are recorded with evidence in
`docs/phase-15-risk-register.md`.

- Up to ~24h of data loss in a disaster; no point-in-time recovery (R-09).
- One operator, no 24-hour cover, no second responder (R-11).
- Email sender authentication incomplete (R-01, R-02).
- Weekly and monthly scheduled jobs may be dropped by GitHub (R-08).
- No branch protection; merge discipline is manual (R-07).
- Legal documents are drafts pending review (`docs/legal-review-checklist.md`).
