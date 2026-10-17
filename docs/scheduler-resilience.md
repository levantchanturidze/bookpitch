# Scheduler resilience — what GitHub delivers, and what we do about it

**Backlog G** (post-release, 2026-10-17). Read-only measurements of GitHub's
own run records, followed by a small change made only in the repository. Nothing
here touched live scheduler configuration. The change takes effect only after the
PR is merged at a release gate.

## 1. What was measured

Source: `GET /repos/{owner}/{repo}/actions/workflows/{file}/runs`, paged and
**unfiltered**. Filtered listings go through GitHub's search backend, which can
serve stale snapshots (#104). Only `event=schedule` runs are counted. Times are
`created_at`. The window is up to 2026-10-16 22:15Z.

| Workflow | Cron line(s) | Requests/day | Delivered/day | Gap p50 | Gap p95 | Gap max |
|---|---|---|---|---|---|---|
| production-monitor | `5,35 * * * *` | 48 | ~4.7 (66 in 14 d) | 5.0 h | 7.4 h | 9.0 h |
| cron, reminders | `*/15 * * * *` | 96 | ~5.1 (36 in 7 d) | 4.7 h | 7.9 h | **9.9 h** |
| cron, housekeeping + digest | `3 * * * *` | 24 | ~4.7 (33 in 7 d) | 4.9 h | 8.1 h | **9.7 h** |
| cron, retention | `17 2 * * *` | 1 | 1 (7 in 7 d) | — | — | — |
| soak controller | `20,50 * * * *` | 48 | ~4.9 | 4.8 h | 7.4 h | 9.6 h |
| sentry-reverify | `35 */4 * * *` | 6 | ~3.4 | 6.5 h | 10.1 h | 11.8 h |
| production-backup | `40 1 * * *` | 1 | 1 | 24.1 h | 24.5 h | 24.5 h |

Three findings.

1. **The throttle applies to each cron line, not to each workflow.** A line that
   asks for 24, 48 or 96 runs a day gets about five. A daily line gets all of
   its runs. `cron.yml`'s two sub-daily lines each got about five, so about ten
   between them in one workflow. History shows the drop happened in steps: the
   monitor got about 30 a day in mid-August, about 7 in September, and 4–6 in
   October.
2. **Lines are delivered independently.** No two `cron.yml` lines fired within
   120 s of each other in the week measured. Across the four soak-relevant
   workflows, 1 of 316 consecutive deliveries was within 60 s of another. When
   `cron.yml`'s deliveries are merged with the monitor's, the share of 24-hour
   windows containing a gap over 6 h drops from **84% to 0%**.
3. **The gaps now exceed the limits that depend on them.**
   - The soak's `observation-gap` limit is 6 h. It was calibrated on 2026-09-04,
     when p95 was 4.13 h and p99 5.03 h. **84%** of 24-hour windows in the last
     14 days contained a larger gap, so a soak started today would almost
     certainly restart.
   - The heartbeat limit for reminders and housekeeping is 6 h. Each of those
     lines had 7–9 gaps over 6 h in a week. That trips the monitor's
     `cron-heartbeat-stale` / `cron-job-*` checks and the soak's `cron-outcomes`
     gate.
   - `MIN_REMINDER_LEAD_HOURS = 8` was calibrated against a 4 h 40 m worst case.
     The reminders line has now gone **9.9 h** without a tick. An organisation
     with a lead time under about 10 h can have appointments start inside a gap
     and never be reminded (`lib/messaging/reminder-window.ts`). The production
     default is 24 h.

## 2. The change (repository only)

| File | Before | After |
|---|---|---|
| `production-monitor.yml` | one line, `5,35 * * * *` | four lines: `7`, `22`, `37`, `52 * * * *` |
| `cron.yml`, reminders | `*/15 * * * *` | plus `26 * * * *` and `41 * * * *` |
| `cron.yml`, housekeeping | `3 * * * *` | plus `33 * * * *` (housekeeping only; the digest does not re-run) |
| `soak-controller.mjs` | gap detail: size only | a failing gap names its interval and attributes it to scheduler delivery |

**Deliberately unchanged:**
- The **6-hour observation-gap limit.** A window that nobody watched for nine hours is not an observed window.
- Every heartbeat and freshness limit.
- `MIN_REMINDER_LEAD_HOURS`.
- Manual dispatches are still not counted as evidence.
- `sentry-reverify`. Its 11.8 h worst gap is inside the 14 h proof expiry, and more probe pairs would cost Sentry quota. This is a watch item; see §5.

**Why this is safe:**
- Each extra line starts a job that already runs. Overlapping ticks are no-ops: reminders dedupe on `message_log` claims, and housekeeping takes an advisory lock and drains with `SKIP LOCKED`.
- Monitor runs take about 20 s and share a concurrency group, so a second overlapping delivery queues. Only a third delivery inside one run would cancel the queued run. The soak counts a cancelled scheduled run *against* the window: a conservative restart, never a false pass. No monitor run has been cancelled in 60 days.
- Actions minutes are free for this public repository.
- Minutes avoid :00–:05, the top-of-hour load window that GitHub documents as the main cause of delay.

**Expected effect, if the per-line model holds:** about 20 monitor observations
a day, a gap p50 under 1.5 h, and a worst case well below 6 h. Reminders and
housekeeping should see roughly 15 and 10 ticks a day respectively, which brings
their worst cases back inside the 6 h heartbeat limits.

## 3. Verifying it after merge (natural runs only)

Measure seven days of **scheduled, attempt-1** runs from the unfiltered listing,
starting from the first natural run after deploy. Do not dispatch anything to
produce evidence.

| Criterion | Pass |
|---|---|
| Monitor scheduled runs per day | at least 15 |
| Monitor max gap | under 5 h |
| Share of 24 h windows with a monitor gap over 6 h | under 5% |
| Reminders line union max gap | under 6 h (heartbeat limit) |
| Housekeeping union max gap | under 6 h |
| Cancelled scheduled monitor runs | 0 |

If the criteria fail, the per-line model is wrong or GitHub has changed again.
Do **not** raise the thresholds. Escalate to the decision in §5.

## 4. Telling failures apart (where each class is detected)

| Class | Detected by | Effect |
|---|---|---|
| Application failure | monitor checks (`health-endpoint`, `production-5xx`, `ops-metrics`, outbox, `reminders-missed`, …) | FAIL, incident, soak `monitor-clean` restarts the window |
| Workflow execution failure | `cron-failures` (scheduled runs that failed), the monitor run's own conclusion | FAIL, incident, soak restart |
| Scheduler delivery delay | `cron-staleness` (says whether GitHub or the app is at fault), `cron-delivery-lag` (informational), soak `observation-gap` (now names the undelivered interval) | the monitor reports the cause. The soak still refuses to certify an unwatched hole |
| Missing observation | soak `evidence-resolved` (an unreadable first attempt), `history-continuity` | blocks certification and does **not** restart the window |
| Stale evidence | freshness limits: backup 26 h, restore drill 960 h, job heartbeats 6 h / 30 h, observability proof 14 h | FAIL past the limit |
| Healthy | all of the above green, from natural runs | incidents close only on a natural scheduled run (#98) |

Item H (`reminders-missed` on an empty window) is the one place this taxonomy
was violated: "no eligible work" was reported as an application failure. It is
fixed separately.

## 5. If repository changes are not enough — options for the owner

All of these need credentials, accounts or money, or change what counts as
evidence. None was provisioned.

| Option | Cost | Credentials and burden | Evidence-model impact |
|---|---|---|---|
| **Supabase `pg_cron` + `pg_net`** calling `/api/cron/*` | free (existing plan; `pg_cron` was verified installable on 2026-09-01) | `CRON_SECRET` held in the database (vault); one SQL migration to schedule; monitoring of `cron.job_run_details` | Ticks stop appearing as GitHub runs. The app-side heartbeat becomes the evidence, so the monitor's `cron-staleness` / `cron-failures` and the soak's `scheduled-cron` gate must read heartbeats instead of Actions runs. A real redesign of those gates |
| **Vercel Cron** | Hobby is daily only (insufficient). Pro is about $20/user/month | none beyond the project | same as above: ticks bypass Actions |
| **External dispatcher** (cron-job.org free tier, Cloudflare Workers Cron Triggers free tier) calling `workflow_dispatch` | free | a fine-grained PAT with `actions:write`, rotated, held only by the dispatcher; one more external dependency to monitor | Runs become `workflow_dispatch`, which **this project deliberately excludes from evidence** ("an operator chose the moment"). Accepting them needs a provenance rule: a dedicated bot actor plus a signed input verified by the workflow. A trust decision, not a tweak |
| **More lines** (this change) | free | none | none |

**Recommendation:** merge this change at the next release gate and verify it
against §3. Escalate only if it fails, and prefer `pg_cron` for the reminders
tick in that case. That tick is the one with customer impact, and moving it off
GitHub removes the lead-time dependency entirely.

**Release-gate check (read-only, no PII):** before trusting the 8-hour lead-time
floor, see whether any organisation sits close to it:

```sql
SELECT count(*) AS orgs_with_short_lead FROM organizations WHERE reminder_lead_hours < 10;
```
