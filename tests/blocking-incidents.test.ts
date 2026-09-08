import { describe, it, expect } from 'vitest';
import { confirmOpenIncidents, selectCandidates } from '../scripts/blocking-incidents.mjs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// The listing lags; the per-issue read does not.
//
// `release-verify-and-soak.yml` run 34208400168 closed incident #44 at
// 09:10:36 and re-listed open incidents at 09:10:37, and the search index still
// returned #44. The job refused and never started the soak. Because every
// successful verification closes that incident one step earlier, the gate lost
// that race routinely — a gate that could not go green.
//
// The asymmetry is the whole design, so it is what these tests pin down:
// confirmation may only ever REMOVE a candidate the authoritative read proves
// closed, and an unreadable candidate must keep blocking.
// -----------------------------------------------------------------------------

const issue = (number: number, title = `incident ${number}`) => ({ number, title });

describe('a stale listing cannot block, and an open incident still can', () => {
  it('THE DEFECT: an issue closed a second ago is dismissed, not blocking', async () => {
    const r = await confirmOpenIncidents([issue(44)], async () => ({ state: 'closed' }));
    expect(r.blocking).toEqual([]);
    expect(r.dismissed.map((i) => i.number)).toEqual([44]);
    expect(r.unreadable).toEqual([]);
  });

  it('COMPLEMENT: a genuinely open incident still blocks', async () => {
    const r = await confirmOpenIncidents([issue(90)], async () => ({ state: 'open' }));
    expect(r.blocking.map((i) => i.number)).toEqual([90]);
    expect(r.dismissed).toEqual([]);
  });

  it('mixed: only the confirmed-open one survives', async () => {
    const states: Record<number, string> = { 44: 'closed', 91: 'open', 92: 'closed' };
    const r = await confirmOpenIncidents([issue(44), issue(91), issue(92)], async (n: number) => ({
      state: states[n],
    }));
    expect(r.blocking.map((i) => i.number)).toEqual([91]);
    expect(r.dismissed.map((i) => i.number)).toEqual([44, 92]);
  });

  it('COMPLEMENT: an unreadable issue BLOCKS — unknown is not closed', async () => {
    const r = await confirmOpenIncidents([issue(93)], async () => {
      throw new Error('502 from GitHub');
    });
    expect(
      r.blocking.map((i) => i.number),
      'a read failure must not clear a gate',
    ).toEqual([93]);
    expect(r.unreadable.map((i) => i.number)).toEqual([93]);
    expect(r.dismissed).toEqual([]);
  });

  it('COMPLEMENT: a null or shapeless response blocks too', async () => {
    for (const bad of [null, undefined, {}, { state: 42 }, { state: null }]) {
      const r = await confirmOpenIncidents([issue(94)], async () => bad as never);
      expect(
        r.blocking.map((i) => i.number),
        JSON.stringify(bad),
      ).toEqual([94]);
      expect(r.unreadable.map((i) => i.number)).toEqual([94]);
    }
  });

  it('an unexpected state string is treated as open, not as closed', async () => {
    // Only the literal 'closed' dismisses. Anything else keeps the candidate.
    const r = await confirmOpenIncidents([issue(95)], async () => ({ state: 'reopened' }));
    expect(r.blocking.map((i) => i.number)).toEqual([95]);
    expect(r.dismissed).toEqual([]);
  });

  it('nothing listed is nothing blocking', async () => {
    for (const empty of [[], null, undefined]) {
      const r = await confirmOpenIncidents(empty as never, async () => ({ state: 'open' }));
      expect(r.blocking).toEqual([]);
    }
  });

  it('every candidate is checked — none is skipped after the first dismissal', async () => {
    const asked: number[] = [];
    await confirmOpenIncidents([issue(1), issue(2), issue(3)], async (n: number) => {
      asked.push(n);
      return { state: 'closed' };
    });
    expect(asked).toEqual([1, 2, 3]);
  });
});

// -----------------------------------------------------------------------------
// The candidate list, and the CLI's real exit code.
//
// The workflow used to carry this logic inline, and tests asserted the STRINGS
// in its `run:` block. That checks the wording, not the behaviour. These drive
// the actual process against a stub GitHub and read what it does.
// -----------------------------------------------------------------------------

const OBS_BODY = 'marker bookpitch-ops-incident:production-observability-unconfigured here';

describe('candidate selection', () => {
  it('pull requests are not incidents', () => {
    const got = selectCandidates([
      { number: 1, title: 'a', pull_request: { url: 'x' } },
      { number: 2, title: 'b' },
    ]);
    expect(got.map((c) => c.number)).toEqual([2]);
  });

  it('the observability incident is excluded ONLY when asked', () => {
    const issues = [
      { number: 44, title: 'obs', body: OBS_BODY },
      { number: 90, title: 'other', body: 'unrelated' },
    ];
    expect(
      selectCandidates(issues, { allowObservability: true }).map((c) => c.number),
      'the release path resolves this one, so it must not deadlock on it',
    ).toEqual([90]);
    expect(
      selectCandidates(issues).map((c) => c.number),
      'COMPLEMENT: the post-verification re-check still counts it',
    ).toEqual([44, 90]);
  });
});

describe('the CLI exits on what it confirms, against a stub GitHub', () => {
  const script = fileURLToPath(new URL('../scripts/blocking-incidents.mjs', import.meta.url));

  /** Serve a listing plus per-issue states, so the two can DISAGREE. */
  async function withStub(
    listing: Array<Record<string, unknown>>,
    states: Record<number, string>,
    args: string[] = [],
  ): Promise<{ code: number; out: string }> {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const m = /\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(req.url ?? '');
      if (m) {
        const n = Number(m[1]);
        if (!(n in states)) {
          res.statusCode = 502;
          return res.end('{}');
        }
        return res.end(JSON.stringify({ number: n, state: states[n] }));
      }
      res.end(JSON.stringify(listing));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise((resolve) => {
        execFile(
          process.execPath,
          [script, ...args],
          {
            env: {
              ...process.env,
              GITHUB_API_URL: `http://127.0.0.1:${port}`,
              GITHUB_REPOSITORY: 'acme/app',
              GITHUB_TOKEN: 'stub-token-not-a-secret',
            },
          },
          (err, stdout, stderr) => {
            const code = (err as { code?: number } | null)?.code ?? 0;
            resolve({ code, out: `${stdout}${stderr}` });
          },
        );
      });
    } finally {
      server.close();
    }
  }

  it('THE DEFECT: a listing that still shows a closed incident exits 0', async () => {
    // Exactly run 34208400168: the listing named #44, the issue was closed.
    const r = await withStub([{ number: 44, title: 'obs' }], { 44: 'closed' });
    expect(r.out).toMatch(/stale index, ignored/);
    expect(r.code, 'a release must not be refused by a stale index').toBe(0);
  });

  it('COMPLEMENT: a genuinely open incident exits 1', async () => {
    const r = await withStub([{ number: 90, title: 'ops metrics failing' }], { 90: 'open' });
    expect(r.out).toMatch(/#90 ops metrics failing/);
    expect(r.out).toMatch(/1 production incident\(s\) confirmed open/);
    expect(r.code).toBe(1);
  });

  it('COMPLEMENT: an unreadable issue exits 1 — unknown is not clear', async () => {
    // The stub answers 502 for any number it does not know.
    const r = await withStub([{ number: 93, title: 'unknown' }], {});
    expect(r.out).toMatch(/could not be read — treated as blocking/);
    expect(r.code).toBe(1);
  });

  it('nothing open exits 0', async () => {
    const r = await withStub([], {});
    expect(r.out).toMatch(/No production incident is open/);
    expect(r.code).toBe(0);
  });

  it('--allow-observability lets THAT incident through and still blocks others', async () => {
    const listing = [
      { number: 44, title: 'obs', body: OBS_BODY },
      { number: 91, title: 'unrelated' },
    ];
    const allowed = await withStub(listing, { 44: 'open', 91: 'closed' }, [
      '--allow-observability',
    ]);
    expect(allowed.code, 'the incident this path resolves must not deadlock it').toBe(0);

    const strict = await withStub(listing, { 44: 'open', 91: 'closed' });
    expect(strict.code, 'COMPLEMENT: without the flag it blocks').toBe(1);

    const other = await withStub(listing, { 44: 'open', 91: 'open' }, ['--allow-observability']);
    expect(other.code, 'an unrelated open incident still blocks').toBe(1);
  });
});
