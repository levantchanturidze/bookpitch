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
    run?.runAttempt === 1 &&
    // An immutable scheduling time is required, not merely preferred. Falling
    // back to `updated_at` — which a re-run moves — would let someone slide a
    // run across a window boundary.
    run?.scheduledAtIsExact === true
  );
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
  if (run?.unresolved === true) {
    return `run ${run.runId}'s first attempt could not be retrieved`;
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
