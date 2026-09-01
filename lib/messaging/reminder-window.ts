// Leaf module on purpose: a constant describing what the SCHEDULER can
// deliver should be readable without booting the database layer. Importing it
// from lib/messaging/reminders.ts pulls in lib/db and, transitively, next-auth.

/**
 * Smallest reminder lead time the scheduler can actually honour.
 *
 * The reminder window is a SLIDING one: each tick selects appointments in
 * [now, now + reminderLeadHours]. An appointment is therefore caught only if a
 * tick fires within `reminderLeadHours` of its start. If ticks arrive further
 * apart than the lead time, appointments are not reminded LATE — they are
 * never reminded at all, because by the time the next tick runs the
 * appointment has already started and has left the window.
 *
 * Measured delivery of the declared 15-minute cron schedule on 2026-09-01
 * (scheduled events only, manual dispatches excluded):
 *
 *   00:05  00:27  05:07  06:07  06:24  07:49  10:05  12:26  14:52  17:13  18:08
 *
 * The largest gap is 4h40m against a declared 15 minutes. GitHub does not
 * guarantee scheduled delivery and this account routinely sees hours (R-08).
 *
 * So the default 24h lead is safe with roughly five times the margin, and
 * every organization in production is on it — but `saveLeadHoursAction`
 * accepted anything from 1 hour upward. A single owner setting 4 hours in the
 * UI would have silently armed exactly the failure above, with no error, no
 * log line, and no monitor check that could see it: the reminders simply never
 * arrive.
 *
 * 8 hours clears the measured worst case with margin. Raising the floor is the
 * conservative direction — it can only cause reminders to be sent EARLIER than
 * an operator asked, never not at all.
 *
 * This is a scheduler-derived constant. If Bookpitch ever moves to a scheduler
 * with a real delivery guarantee (Supabase pg_cron is available and was
 * verified installable on 2026-09-01; Vercel Cron on the current Hobby plan is
 * daily-only and cannot serve this), lower it deliberately and record the new
 * measured worst case here.
 */
export const MIN_REMINDER_LEAD_HOURS = 8;
