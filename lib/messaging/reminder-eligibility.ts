import { HEARTBEAT_MAX_AGE_MINUTES } from '@/lib/cron-heartbeat-jobs';

// -----------------------------------------------------------------------------
// When is a reminder OWED, and which appointments does a tick select?
//
// Three pieces of code answer versions of this question, and every time two of
// them have disagreed the result has been a customer who was not contacted
// while every dashboard stayed green:
//
//   runtime selection      lib/messaging/reminders.ts — which appointments this
//                          tick attempts;
//   claim / lease          alreadyReminded() — whether another worker already
//                          holds this one;
//   missed-reminder metric lib/ops-metrics.ts — which appointments SHOULD have
//                          been reminded and were not.
//
// The rules they share live here so they cannot drift apart quietly.
//
// ---------------------------------------------------------------------------
// Rule 1 — every time comparison happens on the DATABASE clock.
//
// `appointments.starts_at`, `appointments.created_at` and
// `message_log.created_at` are all PostgreSQL timestamptz values, defaulted or
// written by PostgreSQL. Anything that compares them against a Node-derived
// instant is comparing two machines' clocks: the application runs on Vercel and
// the database on Supabase, with independent NTP.
//
// This project has now found that same bug four times — the retention cutoff,
// the cron heartbeat, the reminder claim lease, and the reminder selection
// window itself. The selection window was the worst of them: it slides the
// whole `[now, now + lead]` interval with the application server's clock, so a
// fast clock opens the window past appointments that are about to start, and
// once they start they leave the window permanently. There is no later tick
// that recovers them.
//
// ---------------------------------------------------------------------------
// Rule 2 — "attempted" and "owed" must not contradict each other.
//
// The runtime selects on `starts_at` alone and puts NO condition on
// `created_at`: an appointment booked eight hours ahead under a 24-hour lead is
// inside the window the moment it exists. So the metric cannot use the lead
// time as its eligibility bound — it would exclude exactly the population the
// runtime does attempt, which is most same-day bookings.
//
// The metric therefore counts an appointment as owed when EITHER
//
//   * a message_log row exists for it — the runtime demonstrably reached it,
//     whenever it was booked; or
//   * it existed for longer than OWED_MIN_LEAD_MINUTES before starting, so a
//     scheduled tick should have run in between.
// -----------------------------------------------------------------------------

/**
 * How long an appointment must have existed before it starts before a
 * never-attempted reminder counts as missed.
 *
 * Bounded by the same measured worst-case scheduler delivery gap the heartbeat
 * check uses, so the two signals cannot disagree about whether a tick was owed.
 * Anything tighter makes the metric permanently non-zero for a clinic taking
 * same-day bookings, and a permanently non-zero alarm is an ignored one.
 */
export const OWED_MIN_LEAD_MINUTES = HEARTBEAT_MAX_AGE_MINUTES.reminders;

/**
 * The selection window, as SQL, on the database clock.
 *
 * `[NOW(), NOW() + reminderLeadHours]`. Returned as a fragment rather than a
 * Date pair precisely so no caller can be tempted to compute the bound in Node
 * and pass it in.
 *
 * The lead hours come from the organization row inside the same query, so the
 * window is per-tenant without a second round trip.
 */
export const REMINDER_WINDOW_SQL = `
  a.starts_at >= NOW()
  AND a.starts_at <= NOW() + make_interval(hours => o.reminder_lead_hours)
` as const;

/** Statuses a tick never attempts. Shared so the metric can mirror it. */
export const REMINDER_SKIPPED_STATUSES = ['cancelled', 'completed'] as const;
