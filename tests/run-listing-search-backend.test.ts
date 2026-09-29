import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  listWorkflowRuns,
  runsWhere,
  SEARCH_BACKED_RUN_FILTERS,
} from '../scripts/run-evidence.mjs';
import {
  collectCronRuns,
  evaluateCronHealth,
  latestSuccessfulRun,
} from '../scripts/production-monitor.mjs';
import { collectRuns } from '../scripts/soak-controller.mjs';

// -----------------------------------------------------------------------------
// GitHub's filtered run listing answers from a stale snapshot, sometimes.
//
// Captured 2026-09-29T20:28:02Z, one second apart:
//
//   /actions/workflows/cron.yml/runs?branch=main&event=schedule&per_page=20
//       total_count 964, newest run 34919059437 created 2026-09-15T01:53:49Z
//   /actions/workflows/cron.yml/runs?per_page=20
//       total_count 1713, newest run 36612915168 created 2026-09-29T18:33:38Z
//
// Fifteen seconds later the filtered listing answered 1699 and 18:33 again.
// The production monitor read the filtered listing, and on 3 of 29 natural
// runs between 2026-09-24 and 2026-09-29 it reported the crons dead for 247h,
// 163h and 340h — reopening incident #37 each time — while its own database
// heartbeat said the cron had run within the last few hours. The soak
// controller read its evidence the same way.
//
// These tests pin the fix: every consumer reads the UNFILTERED listing and
// filters it itself, and no script may send a filtered run listing again.
// -----------------------------------------------------------------------------

const NOW = new Date('2026-09-29T20:28:02Z');
const HOUR = 3_600_000;

type ApiRun = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  head_branch: string;
};

function apiRun(id: number, createdAt: string, over: Partial<ApiRun> = {}): ApiRun {
  const created = new Date(createdAt);
  return {
    id,
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: created.toISOString(),
    updated_at: new Date(created.getTime() + 60_000).toISOString(),
    head_branch: 'main',
    ...over,
  };
}

/** `n` hourly scheduled successes, newest first, the newest at `newest`. */
function hourly(firstId: number, newest: string, n: number, over: Partial<ApiRun> = {}) {
  const t = new Date(newest).getTime();
  return Array.from({ length: n }, (_, i) =>
    apiRun(firstId - i, new Date(t - i * HOUR).toISOString(), over),
  );
}

/** What the search backend served at 20:28:02Z: nothing after 2026-09-15. */
const STALE_FILTERED = hourly(34919059437, '2026-09-15T01:53:49Z', 20);
/** What the unfiltered listing served in the same second. */
const CURRENT_UNFILTERED = [
  ...hourly(36612915168, '2026-09-29T18:33:38Z', 18),
  apiRun(36590000001, '2026-09-29T00:10:00Z', { event: 'workflow_dispatch' }),
  apiRun(36590000002, '2026-09-28T23:10:00Z', { event: 'pull_request', head_branch: 'x' }),
];

/** A fetchPage over a fixed listing, page size honoured, recording each call. */
function pager(all: ApiRun[]) {
  const calls: Array<{ page: number; perPage: number }> = [];
  const fetchPage = async (page: number, perPage: number) => {
    calls.push({ page, perPage });
    return {
      total_count: all.length,
      workflow_runs: all.slice((page - 1) * perPage, page * perPage),
    };
  };
  return { fetchPage, calls };
}

const noAttemptOne = async () => null;
const staleness = (results: Array<{ id: string; ok: boolean; detail: string }>) =>
  results.find((r) => r.id === 'cron-staleness')!;

describe('THE DEFECT: the monitor believed the stale snapshot', () => {
  it('reproduced — fed the filtered answer, cron-staleness reports the crons dead for ~15 days', async () => {
    // Exactly what the old code did: the filtered listing, normalised, evaluated.
    const { fetchPage } = pager(STALE_FILTERED);
    const runs = await collectCronRuns(fetchPage, noAttemptOne);
    const check = staleness(evaluateCronHealth(runs, NOW));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/SUCCEEDED 3\d\d\.\dh ago/);
  });

  it('fixed — the unfiltered listing of the same second shows the crons alive', async () => {
    const { fetchPage } = pager(CURRENT_UNFILTERED);
    const runs = await collectCronRuns(fetchPage, noAttemptOne);
    const check = staleness(evaluateCronHealth(runs, NOW));
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toMatch(/last success 1\.9h ago/);
  });

  it('the complement — if the crons REALLY stopped, the unfiltered listing still fails the check', async () => {
    // Same listing shape, but the newest scheduled run is 40 hours old.
    const { fetchPage } = pager(hourly(36000000000, '2026-09-28T04:28:02Z', 20));
    const runs = await collectCronRuns(fetchPage, noAttemptOne);
    const check = staleness(evaluateCronHealth(runs, NOW));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/SUCCEEDED 40\.0h ago/);
  });

  it('splits one listing by event: dispatches and other branches never count as scheduled', async () => {
    const { fetchPage, calls } = pager(CURRENT_UNFILTERED);
    const runs = await collectCronRuns(fetchPage, noAttemptOne);
    expect(calls).toEqual([{ page: 1, perPage: 100 }]);
    expect(runs.filter((r) => r.event === 'schedule')).toHaveLength(18);
    expect(runs.filter((r) => r.event === 'workflow_dispatch')).toHaveLength(1);
    expect(runs.some((r) => r.runId === 36590000002)).toBe(false); // pull_request, branch x
  });
});

describe('the verdict does not depend on the order a listing arrives in', () => {
  it('a stale run first in the array does not hide a newer success later in it', () => {
    const toRun = (r: ApiRun) => ({
      runId: r.id,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      runAttempt: r.run_attempt,
      scheduledAt: r.created_at,
      scheduledAtIsExact: true,
      completedAt: r.updated_at,
      unresolved: false,
    });
    const oldFirst = [...STALE_FILTERED.slice(0, 3), ...CURRENT_UNFILTERED.slice(0, 3)].map(toRun);
    const newFirst = [...oldFirst].reverse();
    const a = staleness(evaluateCronHealth(oldFirst, NOW));
    const b = staleness(evaluateCronHealth(newFirst, NOW));
    expect(a.ok, a.detail).toBe(true);
    expect(a).toEqual(b);
  });
});

describe('listWorkflowRuns — paging the unfiltered listing', () => {
  const many = hourly(5000, '2026-09-29T20:00:00Z', 250);

  it('stops at the first page that reaches `since`, and says the history is complete', async () => {
    const { fetchPage, calls } = pager(many);
    const since = new Date(Date.parse('2026-09-29T20:00:00Z') - 150 * HOUR).toISOString();
    const { runs, complete } = await listWorkflowRuns(fetchPage, { since, maxPages: 6 });
    expect(calls.map((c) => c.page)).toEqual([1, 2]);
    expect(complete).toBe(true);
    expect(runs).toHaveLength(200);
  });

  it('a short page is the end of the listing', async () => {
    const { fetchPage, calls } = pager(many.slice(0, 30));
    const { complete } = await listWorkflowRuns(fetchPage, { since: '2020-01-01T00:00:00Z' });
    expect(calls).toHaveLength(1);
    expect(complete).toBe(true);
  });

  it('an exhausted page budget is NOT complete — what is missing is the oldest', async () => {
    const { fetchPage } = pager(many);
    const { runs, complete } = await listWorkflowRuns(fetchPage, {
      since: '2020-01-01T00:00:00Z',
      maxPages: 2,
    });
    expect(complete).toBe(false);
    expect(runs).toHaveLength(200);
  });

  it('a run that shifts across a page boundary is counted once', async () => {
    const pages = [many.slice(0, 100), many.slice(99, 199), many.slice(198, 250)];
    const { runs } = await listWorkflowRuns(async (page) => ({ workflow_runs: pages[page - 1] }), {
      since: '2020-01-01T00:00:00Z',
    });
    expect(runs).toHaveLength(250);
    expect(new Set(runs.map((r) => r.id)).size).toBe(250);
  });

  it('returns newest first by created_at even if a page arrives shuffled', async () => {
    const shuffled = [...many.slice(0, 40)].sort((a, b) => (a.id % 7) - (b.id % 7));
    const { runs } = await listWorkflowRuns(async () => ({ workflow_runs: shuffled }));
    const times = runs.map((r) => Date.parse(r.created_at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('`enough` stops the walk early, without claiming completeness', async () => {
    const { fetchPage, calls } = pager(many);
    const { complete } = await listWorkflowRuns(fetchPage, { enough: (rs) => rs.length >= 100 });
    expect(calls).toHaveLength(1);
    expect(complete).toBe(false);
  });

  it('runsWhere applies the filters the search backend used to', () => {
    expect(runsWhere(CURRENT_UNFILTERED, { event: 'schedule', branch: 'main' })).toHaveLength(18);
    expect(runsWhere(CURRENT_UNFILTERED, { event: 'workflow_dispatch' })).toHaveLength(1);
    expect(runsWhere(CURRENT_UNFILTERED, { branch: 'x' })).toHaveLength(1);
    expect(
      runsWhere([apiRun(1, '2026-09-29T00:00:00Z', { conclusion: 'failure' })], {
        conclusion: 'success',
      }),
    ).toHaveLength(0);
  });
});

describe('latestSuccessfulRun — backup and restore-drill freshness', () => {
  it('is the newest first-attempt success on main', async () => {
    const listing = [
      apiRun(9, '2026-09-29T19:00:00Z', { conclusion: 'failure' }),
      apiRun(8, '2026-09-29T18:00:00Z', { run_attempt: 2 }), // a re-run is not evidence
      apiRun(7, '2026-09-29T17:00:00Z', { head_branch: 'feature' }),
      apiRun(6, '2026-09-29T07:27:58Z', { event: 'workflow_dispatch' }), // a hand-made backup is real
      apiRun(5, '2026-09-28T07:00:00Z'),
    ];
    const { fetchPage } = pager(listing);
    expect(await latestSuccessfulRun(fetchPage)).toEqual({
      completedAt: '2026-09-29T07:27:58.000Z',
      runId: 6,
    });
  });

  it('is null when nothing qualifies — which the freshness check reports as a failure', async () => {
    const { fetchPage } = pager([apiRun(1, '2026-09-29T00:00:00Z', { conclusion: 'failure' })]);
    expect(await latestSuccessfulRun(fetchPage)).toBeNull();
  });
});

describe('the soak controller reads its window the same way', () => {
  const since = new Date(NOW.getTime() - 24 * HOUR).toISOString();

  it('THE DEFECT: the stale snapshot holds no run inside a 24h window', async () => {
    const { runs } = await collectRuns(
      pager(STALE_FILTERED).fetchPage,
      noAttemptOne,
      'schedule',
      since,
    );
    expect(runs.filter((r) => r.completedAt >= since)).toHaveLength(0);
  });

  it('the unfiltered listing holds the window, scheduled runs on main only', async () => {
    const { runs, complete } = await collectRuns(
      pager(CURRENT_UNFILTERED).fetchPage,
      noAttemptOne,
      'schedule',
      since,
    );
    expect(complete).toBe(true);
    expect(runs.filter((r) => r.completedAt >= since)).toHaveLength(18);
    expect(runs.every((r) => r.event === 'schedule')).toBe(true);
  });

  it('a re-run is still replaced by its authoritative first attempt', async () => {
    const rerun = apiRun(77, '2026-09-29T12:00:00Z', { run_attempt: 2, conclusion: 'success' });
    const firstAttempt = { ...rerun, run_attempt: 1, conclusion: 'failure' };
    const { runs } = await collectRuns(
      pager([rerun]).fetchPage,
      async (id: number) => (id === 77 ? firstAttempt : null),
      'schedule',
      since,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].conclusion).toBe('failure');
  });
});

// -----------------------------------------------------------------------------
// Nothing may send a filtered run listing again.
// -----------------------------------------------------------------------------

/** Every `/actions/workflows/<wf>/runs?...` query in `text` that uses a search filter. */
function searchBackedRunQueries(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\/actions\/workflows\/[^\s'"`?]+\/runs\?([^\s'"`]*)/g)) {
    const params = m[1].split('&').map((kv) => kv.split('=')[0]);
    if (params.some((p) => (SEARCH_BACKED_RUN_FILTERS as readonly string[]).includes(p))) {
      out.push(m[0]);
    }
  }
  return out;
}

describe('no script or workflow asks the search backend for runs', () => {
  it('the detector catches the query shape that caused this (the complement)', () => {
    expect(
      searchBackedRunQueries(
        '`/repos/${repo}/actions/workflows/cron.yml/runs?branch=main&event=schedule&per_page=20`',
      ),
    ).toHaveLength(1);
    expect(
      searchBackedRunQueries(
        '"repos/x/actions/workflows/production-backup.yml/runs?status=success&per_page=1"',
      ),
    ).toHaveLength(1);
    expect(
      searchBackedRunQueries(
        '`/repos/${repo}/actions/workflows/${wf}/runs?per_page=${perPage}&page=${page}`',
      ),
    ).toHaveLength(0);
  });

  it('scripts/ and .github/workflows/ contain none', () => {
    const root = join(__dirname, '..');
    const files = [
      ...readdirSync(join(root, 'scripts'))
        .filter((f) => /\.(mjs|js|ts|sh)$/.test(f))
        .map((f) => join(root, 'scripts', f)),
      ...readdirSync(join(root, '.github', 'workflows'))
        .filter((f) => f.endsWith('.yml'))
        .map((f) => join(root, '.github', 'workflows', f)),
    ];
    const offenders = files.flatMap((f) =>
      searchBackedRunQueries(readFileSync(f, 'utf8')).map((q) => `${f}: ${q}`),
    );
    expect(offenders).toEqual([]);
  });
});
