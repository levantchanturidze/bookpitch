import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import type { NextRequest } from 'next/server';
import { withoutRls } from '@/lib/db';

// -----------------------------------------------------------------------------
// §9 — organizations dropped by the per-run cap were invisible.
//
// The route fetches `MAX_ORGS_PER_RUN + 1` organizations, processes the first
// `MAX_ORGS_PER_RUN`, and sets `truncated: true` in the response. That is all
// it does with it. The omitted organizations never enter the heartbeat
// arithmetic:
//
//   expected  = channelsExpected + failures.length   // only from the batch
//   failed    = failedChannels + failures.length + unprocessed
//
// So the first 500 organizations succeed, organization 501 and everything after
// it is never processed, `recordCronHeartbeat` records `success`, the route
// answers 200, the workflow step passes, `cron-job-reminders` is green and the
// soak's `cron-outcomes` gate is satisfied. Reminders for those customers are
// simply not sent, and every signal says the job is healthy.
//
// A log line is not a signal. `log.error('cron.reminders.org_limit_hit')` goes
// to a log nobody reads on a schedule, which is the same category of evidence
// as the Turnstile failure that broke signup for a week.
//
// Driven through CRON_MAX_ORGS_PER_RUN so the case is reachable without
// creating 500 fixtures. The constant is read at module load, so the route is
// imported fresh under each setting.
// -----------------------------------------------------------------------------

const SECRET = 'org-truncation-secret';

function req(): NextRequest {
  return {
    headers: { get: (k: string) => (k === 'authorization' ? `Bearer ${SECRET}` : null) },
  } as unknown as NextRequest;
}

/** Import the route with a specific cap in force. */
async function routeWithCap(cap: string) {
  vi.resetModules();
  process.env.CRON_MAX_ORGS_PER_RUN = cap;
  const mod = await import('@/app/api/cron/reminders/route');
  return mod.POST;
}

let previousSecret: string | undefined;
let previousCap: string | undefined;
let orgCount = 0;

describe('organizations the cap drops cannot be reported as success', () => {
  beforeAll(async () => {
    previousSecret = process.env.CRON_SECRET;
    previousCap = process.env.CRON_MAX_ORGS_PER_RUN;
    process.env.CRON_SECRET = SECRET;
    orgCount = await withoutRls((tx) => tx.organization.count());
    // The fixture database must have more than one organization for a cap of 1
    // to truncate at all; otherwise this suite would pass vacuously.
    expect(orgCount, 'need at least 2 organizations to exercise truncation').toBeGreaterThan(1);
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousCap === undefined) delete process.env.CRON_MAX_ORGS_PER_RUN;
    else process.env.CRON_MAX_ORGS_PER_RUN = previousCap;
    vi.resetModules();
  });

  it('THE DEFECT: a truncated run does not answer 200', async () => {
    const POST = await routeWithCap('1');
    const res = await POST(req());
    const body = await res.json();
    expect(body.truncated, 'the fixture should have truncated').toBe(true);
    expect(res.status, 'omitted organizations are unreminded customers').toBe(500);
    expect(body.ok).toBe(false);
    expect(body.outcome).not.toBe('success');
  });

  it('THE DEFECT: the omitted organizations are counted, not just flagged', async () => {
    const POST = await routeWithCap('1');
    const body = await (await POST(req())).json();
    expect(body.orgsOmitted, 'the count must be reported, not inferred').toBe(orgCount - 1);
    // …and it must be in the failure arithmetic, or the heartbeat stays green.
    expect(body.channels.unreachedOrganizations).toBe(orgCount - 1);
  });

  it('the response says how many organizations exist, so the cap can be sized', async () => {
    const POST = await routeWithCap('1');
    const body = await (await POST(req())).json();
    expect(body.limit).toBe(1);
    expect(body.orgsTotal).toBe(orgCount);
  });

  it('COMPLEMENT: an untruncated run is unaffected', async () => {
    // Without this the fix could simply be "always fail".
    const POST = await routeWithCap(String(orgCount + 10));
    const body = await (await POST(req())).json();
    expect(body.truncated).toBeUndefined();
    expect(body.orgsOmitted ?? 0).toBe(0);
  });

  it('repeated invocations do not silently drift back to success', async () => {
    // The condition is persistent: while the cap is exceeded it must keep
    // failing, on every run, rather than clearing itself.
    const POST = await routeWithCap('1');
    for (let i = 0; i < 3; i++) {
      const res = await POST(req());
      expect((await res.json()).ok, `invocation ${i + 1}`).toBe(false);
    }
  });
});
