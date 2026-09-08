#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Which `ops-incident` issues are ACTUALLY open right now?
//
// -----------------------------------------------------------------------------
// THE DEFECT this exists to fix.
//
// `gh issue list` is served from GitHub's SEARCH index, which is eventually
// consistent: it lags writes by seconds. `release-verify-and-soak.yml` closed
// the observability incident and then, one step later, re-listed open
// incidents to confirm nothing was blocking — and read the pre-close index.
//
// Measured, run 34208400168:
//
//   09:10:36.658  step 9  "closed #44 by evidence"
//   09:10:36Z     REST    issue 44 closed_at
//   09:10:37.797  step 10 lists open incidents -> "#44 [ops] Application …"
//   (minutes later) the same listing returns 0
//
// The job refused and skipped `Start the soak`. Since EVERY successful
// verification closes that incident one step earlier, this gate lost the race
// as a matter of course — which is why no soak had ever started.
//
// -----------------------------------------------------------------------------
// The fix, and the direction it fails in.
//
// The per-issue REST endpoint (`GET /repos/{owner}/{repo}/issues/{n}`) is
// strongly consistent — it is the same read that reported `closed_at` above
// while the listing still said open. So the listing is used only to NOMINATE
// candidates, and each candidate's state is then confirmed directly.
//
// The two stalenesses are not symmetrical, and only one of them is dangerous:
//
//   listing shows a CLOSED issue as open   -> a false refusal. Safe. This is
//                                             what happened, and confirmation
//                                             removes it.
//   listing OMITS a genuinely open issue   -> a false pass. Dangerous. No
//                                             per-issue read can fix this,
//                                             because the issue was never
//                                             nominated. A settle delay before
//                                             listing narrows it; nothing here
//                                             closes it completely.
//
// So confirmation is only ever allowed to REMOVE a candidate that the
// authoritative read proves closed. An unreadable candidate stays blocking:
// "I could not check" is not "it is fine", which is the same rule the Sentry
// verifier applies to an indeterminate outcome.
// -----------------------------------------------------------------------------

/**
 * Confirm which nominated incidents are genuinely open.
 *
 * @param {Array<{number: number, title?: string}>} listed candidates from the
 *   (possibly stale) search listing
 * @param {(n: number) => Promise<{state?: string}|null>} fetchIssue
 *   authoritative per-issue read; may throw or return null when unreadable
 * @returns {Promise<{blocking: Array<{number: number, title?: string}>,
 *                    dismissed: Array<{number: number, title?: string}>,
 *                    unreadable: Array<{number: number, title?: string}>}>}
 */
export async function confirmOpenIncidents(listed, fetchIssue) {
  const blocking = [];
  const dismissed = [];
  const unreadable = [];
  for (const candidate of listed ?? []) {
    let issue = null;
    let failed = false;
    try {
      issue = await fetchIssue(candidate.number);
    } catch {
      failed = true;
    }
    if (failed || !issue || typeof issue.state !== 'string') {
      // Unreadable is not closed. It blocks, and it is reported separately so
      // an operator can tell a real incident from a GitHub read failure.
      unreadable.push(candidate);
      blocking.push(candidate);
      continue;
    }
    if (issue.state === 'closed') {
      dismissed.push(candidate);
      continue;
    }
    blocking.push(candidate);
  }
  return { blocking, dismissed, unreadable };
}

// -----------------------------------------------------------------------------
// CLI — used by release-verify-and-soak.yml.
//
//   node scripts/blocking-incidents.mjs                  every open incident blocks
//   node scripts/blocking-incidents.mjs --allow-observability
//                                                        the incident this
//                                                        release path exists to
//                                                        resolve does not block
//
// Exits 1 if anything is confirmed blocking, 0 otherwise. Needs GITHUB_TOKEN
// (or GH_TOKEN) and GITHUB_REPOSITORY.
//
// Nomination uses the REST issues listing rather than `gh issue list`, which
// goes through the search index — the thing that was stale. Confirmation then
// uses the per-issue endpoint regardless, so a stale nomination cannot decide
// anything on its own.
// -----------------------------------------------------------------------------

export const OBSERVABILITY_MARKER = 'bookpitch-ops-incident:production-observability-unconfigured';

/**
 * Which listed issues are candidates for blocking.
 *
 * The REST issues listing includes pull requests, which are not incidents. And
 * the observability incident is the one the release path exists to resolve —
 * refusing while it is open was a deadlock, because it cannot be closed without
 * the verification that refused to start. It is excluded ONLY when the caller
 * asks, so the post-verification re-check still counts it.
 *
 * @param {Array<any>} issues raw REST issue objects
 * @param {{allowObservability?: boolean}} [opts]
 */
export function selectCandidates(issues, opts = {}) {
  return (issues ?? [])
    .filter((i) => i && !i.pull_request)
    .filter(
      (i) => !(opts.allowObservability && String(i.body ?? '').includes(OBSERVABILITY_MARKER)),
    )
    .map((i) => ({ number: i.number, title: i.title }));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!repo || !token) {
    console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
    process.exit(1);
  }
  const allowObservability = process.argv.includes('--allow-observability');
  // GitHub Actions sets GITHUB_API_URL; honouring it also gives the tests a
  // seam to point the CLI at a stub server and assert its real exit code.
  const base = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const api = async (path) => {
    const res = await fetch(`${base}/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'bookpitch-blocking-incidents',
      },
    });
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${path}`);
    return res.json();
  };

  const listed = selectCandidates(
    await api(`repos/${repo}/issues?labels=ops-incident&state=open&per_page=100`),
    { allowObservability },
  );

  const { blocking, dismissed, unreadable } = await confirmOpenIncidents(listed, (n) =>
    api(`repos/${repo}/issues/${n}`),
  );

  for (const i of dismissed) {
    console.log(`  #${i.number} listed as open but reads as closed — stale index, ignored`);
  }
  for (const i of unreadable) {
    console.log(`  #${i.number} could not be read — treated as blocking`);
  }
  for (const i of blocking) {
    console.log(`  #${i.number} ${i.title ?? ''}`.trimEnd());
  }

  if (blocking.length) {
    console.log(`::error::${blocking.length} production incident(s) confirmed open.`);
    process.exit(1);
  }
  console.log(
    allowObservability
      ? 'No unrelated production incident is open.'
      : 'No production incident is open.',
  );
}

// Only run as a CLI, never on import from a test.
if (process.argv[1] && process.argv[1].endsWith('blocking-incidents.mjs')) {
  await main();
}
