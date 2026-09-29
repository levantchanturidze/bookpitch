// -----------------------------------------------------------------------------
// What makes a workflow run NATURAL EVIDENCE — that is, evidence about
// unattended operation rather than about someone pressing a button.
//
// The monitor and the soak both filtered on `event === 'schedule'` and nothing
// else. That is not enough, and the gap is a button in the GitHub UI: a run
// KEEPS its `schedule` event when a human presses "Re-run failed jobs".
// GitHub increments `run_attempt`, replaces `conclusion`, and moves
// `updated_at`. The API returns the latest attempt by default.
//
// So the displaced-evidence defect that closed incident #38 — manual runs
// pushing failures out of a window — was still fully available, just through a
// different control. A failed scheduled monitor run could be rerun into a
// success and the soak would see a clean window; a failed backup or cron run
// could be rerun and the natural-success count would rise.
//
// And because `completedAt` was read from `updated_at`, a rerun ALSO moved a
// run's apparent time forward — past recovery boundaries the soak orders
// against. The immutable `created_at` is used for ordering instead.
//
// Shared by both consumers, because two copies of this predicate is how they
// came to disagree in the first place.
// -----------------------------------------------------------------------------

/**
 * Trim a GitHub API workflow-run object to the fields that decide anything,
 * and keep the two timestamps apart.
 *
 * `run_attempt` missing is treated as 0, not 1: an API shape we do not
 * recognise must not be promoted to authoritative first-attempt evidence.
 *
 * @param {Record<string, any>} r
 */
export function normaliseRun(r) {
  const createdAt = r?.created_at ?? null;
  return {
    runId: r?.id ?? null,
    event: r?.event ?? null,
    status: r?.status ?? null,
    conclusion: r?.conclusion ?? null,
    // 0 rather than 1 when absent — see above.
    runAttempt: typeof r?.run_attempt === 'number' ? r.run_attempt : 0,
    // Immutable: a rerun does not change when the run was first created.
    scheduledAt: createdAt ?? r?.updated_at ?? null,
    scheduledAtIsExact: Boolean(createdAt),
    // Mutable: a rerun moves this.
    completedAt: r?.updated_at ?? null,
    // Set when a re-run's authoritative first attempt could not be retrieved.
    // Present on every record so the shape is uniform and a caller cannot read
    // `undefined` and take it for `false`.
    unresolved: false,
  };
}

/**
 * Was this run delivered by the scheduler, unattended, on its first attempt?
 *
 * True for a first-attempt scheduled run whatever its conclusion — a genuine
 * failure must stay VISIBLE, because the soak needs to see it in order to reset
 * the window. Hiding failures is how a rerun would erase one.
 */
export function isNaturalObservation(run) {
  return (
    run?.event === 'schedule' &&
    // An immutable scheduling time is required, not merely preferred. Falling
    // back to `updated_at` — which a re-run moves — would let someone slide a
    // run across a window boundary.
    run?.scheduledAtIsExact === true &&
    // Attempt 1 is the authoritative record — OR the record is one whose
    // attempt 1 could not be READ.
    //
    // Requiring `runAttempt === 1` alone reopened the hole `resolveRun` was
    // written to close. An unreadable first attempt comes back carrying the
    // LATEST attempt's number, which is 2 or more, so every consumer filtering
    // on this predicate dropped it — and the surrounding successes carried the
    // gate again. Reproduced through evaluateSoak(): with enough clean
    // observations either side, an unreadable in-window first attempt returned
    // `success`, while the same first attempt retrieved as a failure restarted
    // the window.
    //
    // So an unresolved record IS an observation. What it observes is UNKNOWN,
    // which `isNaturalSuccess` refuses and the consumers' gates block on.
    (run?.runAttempt === 1 || run?.unresolved === true)
  );
}

/**
 * A scheduled run that reached us with no readable outcome.
 *
 * Not a failure — nothing was observed to fail — and emphatically not a
 * success. Consumers must let this BLOCK a verdict rather than resolve one in
 * either direction.
 */
export function isUnknownObservation(run) {
  return isNaturalObservation(run) && run?.unresolved === true;
}

/**
 * Is this record ready to be judged at all?
 *
 * Both consumers filtered on `status === 'completed'`, which is right for a run
 * genuinely still executing and wrong for a RE-RUN whose latest attempt is in
 * progress: attempt 1 finished long ago, possibly by failing, and the record
 * carries the latest attempt's status. Dropping it hid the original failure
 * behind a re-run someone had only just started — the same erasure, reached by
 * pressing the button and not waiting.
 */
export function isJudgeable(run) {
  return run?.status === 'completed' || run?.unresolved === true;
}

/** Natural, complete, and successful. The only thing that counts toward a gate. */
export function isNaturalSuccess(run) {
  return (
    isNaturalObservation(run) &&
    // An unresolved re-run is not a success: its authoritative first attempt
    // could not be read, and unknown is not health.
    run.unresolved !== true &&
    run.status === 'completed' &&
    run.conclusion === 'success'
  );
}

/**
 * Why this run is not natural evidence, for a human reading a log. Null when it
 * is.
 */
export function naturalEvidenceProblem(run) {
  if (run?.event !== 'schedule') {
    return `run ${run?.runId} was triggered by ${run?.event ?? 'an unknown event'}, not the schedule`;
  }
  // Ahead of the attempt-number branch: an unresolved record carries the LATEST
  // attempt's number, so that branch would report "re-run by hand" for a record
  // whose actual problem is that its first attempt could not be read.
  if (run?.unresolved === true) {
    return (
      `run ${run.runId}'s first attempt could not be retrieved, so its authoritative outcome ` +
      'is unknown — which is not success and not failure, and blocks a verdict either way'
    );
  }
  if (run?.runAttempt !== 1) {
    return (
      `run ${run.runId} is attempt ${run.runAttempt || 'unknown'} — it was re-run by hand, so its ` +
      'first, authoritative outcome is not what is being reported'
    );
  }
  if (run?.scheduledAtIsExact !== true) {
    return (
      `run ${run.runId} carries no immutable created_at; updated_at moves when a run is ` +
      're-run, so it cannot stand in as the scheduling time'
    );
  }
  return null;
}

/**
 * The AUTHORITATIVE record for a run, fetching attempt 1 when the list gave us
 * a later one.
 *
 * GitHub's run list returns one record per run — the LATEST attempt. After
 * "Re-run failed jobs" that record reads `run_attempt: 2, conclusion:
 * 'success'`, and the original failure is only reachable through
 * `/actions/runs/{id}/attempts/1`.
 *
 * The first fix simply excluded `run_attempt > 1`. That stopped a re-run
 * COUNTING as a success — and also removed the record from the FAILURE set, so
 * the scheduled failure vanished from the window and the surrounding successes
 * carried the gate. Re-running a failed monitor run still cleaned the window;
 * it just took a different route.
 *
 * When attempt 1 cannot be read the record is KEPT and marked `unresolved`. It
 * is not a success and it does not disappear: unknown is not health, and a
 * record that vanishes is indistinguishable from one that never failed.
 *
 * @param {Record<string, any>} apiRun  the record from the runs list
 * @param {(runId: number) => Promise<Record<string, any>|null>} fetchAttemptOne
 */
export async function resolveRun(apiRun, fetchAttemptOne) {
  const latest = normaliseRun(apiRun);
  if (latest.runAttempt === 1) return latest;

  let first = null;
  try {
    first = await fetchAttemptOne(latest.runId);
  } catch {
    first = null;
  }
  if (!first) return { ...latest, unresolved: true, conclusion: null };

  const resolved = normaliseRun(first);
  // Belt and braces: if the attempt endpoint returns something that is not
  // attempt 1, treat it as unreadable rather than believing it.
  if (resolved.runAttempt !== 1) return { ...latest, unresolved: true, conclusion: null };
  return resolved;
}

// -----------------------------------------------------------------------------
// Reading a workflow's runs WITHOUT GitHub's search backend.
//
// `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs` answers from two
// different places. Any of `actor`, `branch`, `check_suite_id`, `created`,
// `event`, `head_sha` or `status` turns the request into a SEARCH, which GitHub
// documents as capped at 1,000 results, and which on this repository
// intermittently answers from a stale, truncated snapshot:
//
//   2026-09-29T20:28:02Z  ?branch=main&event=schedule   total_count 964,
//                         newest run 2026-09-15T01:53Z
//   same second           unfiltered                     total_count 1713,
//                         newest run 2026-09-29T18:33Z
//   15 seconds later      ?branch=main&event=schedule   total_count 1699, correct
//
// The production monitor believed it on 3 of 29 natural runs between
// 2026-09-24 and 2026-09-29, and reopened incident #37 each time with "last
// success 247.1h / 162.7h / 339.7h ago" while the crons ran every few hours.
// The same run (34974070235) was offered as "the newest" twice, four days
// apart, and the database heartbeat in the same monitor run said the cron had
// worked 1.5 hours earlier. The soak controller read its history through the
// same filter, where a truncated page empties the window and restarts a soak
// on a gap that never happened.
//
// The unfiltered listing has no cap and is ordered newest first. Paging it
// until a run older than `since` appears is complete by construction, and every
// filter is then applied here, where it can be tested. Nothing in scripts/ or
// .github/workflows/ may send a filtered run listing again —
// tests/run-evidence.test.ts refuses the query shape.
// -----------------------------------------------------------------------------

/** Query parameters that send a run listing to the search backend. */
export const SEARCH_BACKED_RUN_FILTERS = Object.freeze([
  'actor',
  'branch',
  'check_suite_id',
  'created',
  'event',
  'head_sha',
  'status',
]);

const createdMs = (r) => Date.parse(r?.created_at ?? r?.updated_at ?? '');

/**
 * Page a workflow's UNFILTERED run listing, newest first.
 *
 * Runs are de-duplicated by id (a run created between two page requests shifts
 * the listing and repeats one record across pages) and returned sorted by the
 * immutable `created_at`, newest first, whatever order the pages arrived in.
 *
 * @param {(page: number, perPage: number) => Promise<{ workflow_runs?: any[] } | null>} fetchPage
 *   fetches one page of `/actions/workflows/{workflow}/runs?per_page=&page=` — and
 *   nothing else: no filter parameters (see SEARCH_BACKED_RUN_FILTERS)
 * @param {{ since?: string | null, maxPages?: number, perPage?: number,
 *           enough?: ((runs: any[]) => boolean) | null }} [opts]
 *   since   stop once a page reaches a run created at or before this instant
 *   enough  stop once this is true of the runs collected so far
 * @returns {Promise<{ runs: any[], complete: boolean }>} raw API run records.
 *   `complete` is true when the listing ended or `since` was reached, i.e. no
 *   run newer than `since` can be missing; false when the page budget ran out
 *   first, or `enough` stopped the walk.
 */
export async function listWorkflowRuns(fetchPage, opts = {}) {
  const { since = null, maxPages = 6, perPage = 100, enough = null } = opts;
  const sinceMs = since ? Date.parse(since) : null;
  const byId = new Map();
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchPage(page, perPage);
    const batch = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    for (const r of batch) if (r && r.id != null) byId.set(r.id, r);
    if (batch.length < perPage) {
      complete = true;
      break;
    }
    if (sinceMs !== null && Math.min(...batch.map(createdMs)) <= sinceMs) {
      complete = true;
      break;
    }
    if (enough && enough([...byId.values()])) break;
  }
  const runs = [...byId.values()].sort((a, b) => createdMs(b) - createdMs(a));
  return { runs, complete };
}

/**
 * The filters the search backend used to apply, applied here instead.
 * `conclusion` is what the API's `status=success` parameter selected on.
 *
 * @param {any[]} runs raw API run records
 * @param {{ event?: string, branch?: string, conclusion?: string }} [where]
 */
export function runsWhere(runs, where = {}) {
  const { event, branch, conclusion } = where;
  return runs.filter(
    (r) =>
      (event === undefined || r.event === event) &&
      (branch === undefined || r.head_branch === branch) &&
      (conclusion === undefined || r.conclusion === conclusion),
  );
}
