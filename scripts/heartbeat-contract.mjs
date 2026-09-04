// -----------------------------------------------------------------------------
// The cron heartbeat contract: which jobs must report, how fresh each one's
// last SUCCESS must be, and what counts as healthy.
//
// Held HERE, and imported by every consumer, because the alternative is that
// the monitored system defines the terms it is graded on. Both consumers had
// that defect, independently:
//
//   production-monitor.mjs  iterated Object.entries(heartbeat.jobs) and took
//                           the staleness threshold from j.maxAgeMinutes. Fixed
//                           in cb1b8f7 by giving the monitor its own list.
//   soak-controller.mjs     did exactly the same thing, on the gate that
//                           decides whether a 24-hour window counts, and was
//                           not fixed at the same time.
//
// Fixing it twice would have left two copies of one contract, which drift. So
// the list, the limits and the judgement live in one module.
//
// It cannot import lib/cron-heartbeat-jobs.ts: this is `.mjs` and that is
// TypeScript, which Node will not load from a `.mjs` module. That exact
// assumption already shipped once as `await import('../lib/sentry-receipt.ts')`
// — it type-checked, passed every test, and would have thrown on its first real
// run. tests/heartbeat-contract.test.ts pins the two against each other so the
// duplication cannot drift in silence.
// -----------------------------------------------------------------------------

/**
 * The jobs that must report a heartbeat, and how stale each one's last SUCCESS
 * may be. Mirrors lib/cron-heartbeat-jobs.ts.
 *
 * `metricKey` is the camelCase key in the ops response; `checkId` keeps the
 * job's own hyphenated spelling so an incident raised against
 * `cron-job-audit-digest` survives a rename of the metric key.
 */
export const EXPECTED_HEARTBEAT_JOBS = Object.freeze([
  Object.freeze({ metricKey: 'reminders', checkId: 'cron-job-reminders', maxAgeMinutes: 360 }),
  Object.freeze({
    metricKey: 'housekeeping',
    checkId: 'cron-job-housekeeping',
    maxAgeMinutes: 360,
  }),
  Object.freeze({ metricKey: 'retention', checkId: 'cron-job-retention', maxAgeMinutes: 1800 }),
  Object.freeze({
    metricKey: 'auditDigest',
    checkId: 'cron-job-audit-digest',
    maxAgeMinutes: 1800,
  }),
]);

/** A finite, non-negative number. Anything else is not a measurement. */
function isAge(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Null is "not recorded"; anything non-numeric is a corrupt document. */
function isAgeOrNull(v) {
  return v === null || v === undefined || isAge(v);
}

/**
 * The exact instant a job last succeeded, as the DATABASE recorded it.
 *
 * The soak used to reconstruct this as `runnerNow - successMinutesAgo`. The age
 * is computed against PostgreSQL's `NOW()` and was then subtracted from the
 * GitHub runner's clock — two machines, on the one comparison that decides
 * whether the nightly sweep landed inside the soak window. Same class as the
 * retention cutoff, the cron heartbeat and the reminder lease.
 *
 * Epoch milliseconds rather than an ISO string because the ops response is
 * numeric-only by construction (assertMetricsAreNumericOnly), and that guard is
 * worth more than the readability.
 *
 * @returns {Date|null} null when absent or unusable — never a guess
 */
export function heartbeatSuccessAt(entry) {
  const ms = entry?.successAtEpochMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}

/**
 * Is this document the document the contract describes?
 *
 * Exact key set. `unhealthyJobsFrom()` used to ignore unknown keys, which
 * stopped a deployment ADDING a passing gate but also let it report a job the
 * monitor has never heard of — a renamed job, a half-applied migration, a
 * response from something else entirely — without comment. The contract says
 * which keys exist; anything else is a violation.
 */
export function validateHeartbeatMap(jobs) {
  const problems = [];
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    return { ok: false, problems: ['the heartbeat job map is absent or not an object'] };
  }
  const expected = new Set(EXPECTED_HEARTBEAT_JOBS.map((j) => j.metricKey));
  for (const key of Object.keys(jobs)) {
    if (!expected.has(key)) {
      problems.push(
        `the deployment reports a job the contract does not name: ${key} — the monitor and the ` +
          'application were built from different contracts',
      );
    }
  }
  for (const key of expected) {
    if (!(key in jobs)) problems.push(`the deployment does not report ${key}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Is one job healthy, judged against the LOCAL limit?
 *
 * `limit` is passed in rather than read from the entry, which is the whole
 * point. `entry.maxAgeMinutes` is still available to callers that want to
 * report a disagreement, but it never decides anything.
 *
 * @param {string} name   metric key, for the message
 * @param {object|null} entry  the ops-response entry, or null when absent
 * @param {number} limit  minutes, from EXPECTED_HEARTBEAT_JOBS
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluateHeartbeatJob(name, entry, limit) {
  if (!entry || typeof entry !== 'object') {
    return {
      ok: false,
      reason:
        `${name} was not reported by this deployment — the heartbeat document did not ` +
        'include it, so nothing is known about whether it runs',
    };
  }
  // Every field is validated before it is used. Only `successMinutesAgo` was,
  // so a string or a NaN anywhere else was compared with `<` and silently
  // agreed with.
  if (typeof entry.present !== 'number') {
    return { ok: false, reason: `${name}'s "present" flag is not numeric` };
  }
  if (entry.outcome !== null && entry.outcome !== undefined && typeof entry.outcome !== 'number') {
    return { ok: false, reason: `${name}'s outcome is not numeric` };
  }
  for (const field of ['expectedUnits', 'processedUnits', 'failedUnits']) {
    if (!isAgeOrNull(entry[field])) {
      return {
        ok: false,
        reason: `${name}'s ${field} is ${JSON.stringify(entry[field])}, which is not a count`,
      };
    }
  }
  if (!entry.present) {
    return {
      ok: false,
      reason: `no heartbeat has ever been recorded for ${name} — it has not completed once`,
    };
  }
  if (entry.outcome === null || entry.outcome === undefined) {
    return {
      ok: false,
      reason:
        `${name} has a heartbeat but no outcome recorded (row predates outcome tracking) — ` +
        'NOT VERIFIED until the job next completes',
    };
  }
  if (entry.outcome !== 1) {
    return {
      ok: false,
      reason:
        `${name}'s last attempt ${entry.outcome === 0 ? 'PARTIALLY FAILED' : 'FAILED'} — ` +
        `${entry.processedUnits ?? '?'} of ${entry.expectedUnits ?? '?'} units, ` +
        `${entry.failedUnits ?? '?'} failed`,
    };
  }
  // Validated as a number BEFORE comparing. `undefined > 360`, `NaN > 360` and
  // `'soon' > 360` are all false, so an unusable value read as "fresh" — the
  // comparison silently agreed with whatever it could not understand.
  if (!isAge(entry.successMinutesAgo)) {
    return {
      ok: false,
      reason:
        `${name} reports a successful outcome but its success timestamp is ` +
        `${JSON.stringify(entry.successMinutesAgo) ?? 'absent'}, which is not an age`,
    };
  }
  if (entry.successMinutesAgo > limit) {
    return {
      ok: false,
      reason:
        `${name} last succeeded ${(entry.successMinutesAgo / 60).toFixed(1)}h ago, ` +
        `limit ${(limit / 60).toFixed(1)}h`,
    };
  }
  // Coherence: a "success" that processed fewer units than it expected is not
  // one, whatever the stored outcome says.
  if (
    isAge(entry.expectedUnits) &&
    isAge(entry.processedUnits) &&
    entry.processedUnits < entry.expectedUnits
  ) {
    return {
      ok: false,
      reason: `${name} reports success but processed ${entry.processedUnits} of ${entry.expectedUnits} units`,
    };
  }
  return {
    ok: true,
    reason:
      `${name} last succeeded ${(entry.successMinutesAgo / 60).toFixed(1)}h ago ` +
      `(limit ${(limit / 60).toFixed(1)}h), ${entry.processedUnits ?? 0} unit(s)`,
  };
}

/**
 * Every required job that is not healthy, by metric key.
 *
 * Iterates the CONTRACT, not the document. A job the deployment omits is
 * unhealthy; a job the deployment invents is ignored, so a deployment can
 * neither remove a gate nor add a passing one.
 *
 * Returns `null` — not `[]` — when the map is absent or unusable. The soak's
 * gate reads null as "could not be read" and refuses to credit the window;
 * returning an empty array would certify a day on no evidence at all.
 *
 * @param {object|null|undefined} jobs
 * @returns {string[]|null}
 */
export function unhealthyJobsFrom(jobs) {
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null;
  // A document that is not the expected document is not evidence about any of
  // its entries. Fail closed on the whole map rather than trusting the parts
  // that happen to look familiar.
  if (!validateHeartbeatMap(jobs).ok) {
    return EXPECTED_HEARTBEAT_JOBS.map((j) => j.metricKey);
  }
  const unhealthy = [];
  for (const { metricKey, maxAgeMinutes } of EXPECTED_HEARTBEAT_JOBS) {
    const verdict = evaluateHeartbeatJob(metricKey, jobs[metricKey] ?? null, maxAgeMinutes);
    if (!verdict.ok) unhealthy.push(metricKey);
  }
  return unhealthy;
}
