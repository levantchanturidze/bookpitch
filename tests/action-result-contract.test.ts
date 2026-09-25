import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { createLocation, createStaff, setAvailability, updateMemberRole } =
  await import('@/lib/admin');
const { safeAction } = await import('@/lib/safe-action');
const { resultFromResponse, GENERIC_ERROR_MESSAGE } = await import('@/lib/action-result');
const { ForbiddenError, InvalidInputError, ConflictError } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// U-01 regression — production UAT 2026-09-25.
//
// Saving availability 18:00 → 09:00 was refused correctly and reported as
// "Minified React error #441". The refusal worked; the explanation did not
// survive the Server Action boundary. The same shape covered ~20 call sites,
// including break-glass and member-role forms, so a privilege denial looked
// exactly like a crash.
//
// The contract under test: actions RETURN outcomes. These tests drive the real
// domain functions, so a regression in either the wrapper or the domain
// message is caught.
// -----------------------------------------------------------------------------

type Session = { organizationId: string; userId: string; email: string; membershipId: string };

describe('U-01 safe Server Action result contract', () => {
  let orgId: string;
  let ownerSession: Session;
  let deskSession: Session;
  let ownerMembershipId: string;
  let staffId: string;
  const trackedUserIds: string[] = [];

  beforeAll(async () => {
    const ts = Date.now();
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `ActionResult Org ${ts}` } });
      const owner = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `ar-owner-${ts}@bookpitch.dev`,
          email: `ar-owner-${ts}@bookpitch.dev`,
        },
      });
      const desk = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `ar-desk-${ts}@bookpitch.dev`,
          email: `ar-desk-${ts}@bookpitch.dev`,
        },
      });
      const ownerRole = await tx.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null },
        select: { id: true },
      });
      const deskRole = await tx.role.findFirstOrThrow({
        where: { key: 'FRONT_DESK', organizationId: null },
        select: { id: true },
      });
      const ownerM = await tx.membership.create({
        data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: ownerRole.id },
      });
      const deskM = await tx.membership.create({
        data: {
          organizationId: org.id,
          userId: desk.id,
          role: 'receptionist',
          roleId: deskRole.id,
        },
      });
      return {
        orgId: org.id,
        ownerId: owner.id,
        ownerM: ownerM.id,
        deskId: desk.id,
        deskM: deskM.id,
        ownerEmail: `ar-owner-${ts}@bookpitch.dev`,
        deskEmail: `ar-desk-${ts}@bookpitch.dev`,
      };
    });
    orgId = seed.orgId;
    ownerMembershipId = seed.ownerM;
    ownerSession = {
      organizationId: orgId,
      userId: seed.ownerId,
      email: seed.ownerEmail,
      membershipId: seed.ownerM,
    };
    deskSession = {
      organizationId: orgId,
      userId: seed.deskId,
      email: seed.deskEmail,
      membershipId: seed.deskM,
    };
    trackedUserIds.push(seed.ownerId, seed.deskId);

    const location = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'AR Location',
      timezone: 'Asia/Tbilisi',
    });
    const staff = await createStaff(ownerSession, {
      locationId: location.id,
      name: 'AR Staff',
      roleTitle: 'AR Role',
    });
    staffId = staff.id;
  });

  afterAll(async () => {
    await withoutRls((tx) =>
      tx.staffAvailability.deleteMany({ where: { staff: { organizationId: orgId } } }),
    );
    await withoutRls((tx) => tx.staff.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.location.deleteMany({ where: { organizationId: orgId } }));
    // Invariant 5 is bidirectional: an org may not keep owner_user_id without an
    // active owner membership, NOR have members with owner_user_id cleared. Both
    // sides must therefore move inside ONE transaction, where the deferred check
    // sees the consistent end state rather than either half-step.
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.organization.updateMany({ where: { id: orgId }, data: { ownerUserId: null } });
    });
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([orgId]);
    await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: { in: trackedUserIds } } }));
    await withoutRls((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  });

  it('invalid availability range returns the domain message, not a framework error', async () => {
    const result = await safeAction('test.setAvailability', () =>
      setAvailability(ownerSession, staffId, [
        { weekday: 6, startTime: '18:00', endTime: '09:00' },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_input');
    // The message the operator reads must describe the problem.
    expect(result.message).toContain('18:00-09:00');
    expect(result.message).toMatch(/ends at or before it starts/);
    // And must not be the thing U-01 actually displayed.
    expect(result.message).not.toMatch(/Minified React error/i);
    expect(result.message).not.toMatch(/react\.dev/i);

    // The refusal is still a refusal: nothing was written.
    const rows = await withoutRls((tx) => tx.staffAvailability.count({ where: { staffId } }));
    expect(rows).toBe(0);
  });

  it('a valid availability range still succeeds (the guard is not simply off)', async () => {
    const result = await safeAction('test.setAvailability', () =>
      setAvailability(ownerSession, staffId, [
        { weekday: 6, startTime: '09:00', endTime: '18:00' },
      ]),
    );
    expect(result.ok).toBe(true);
    const rows = await withoutRls((tx) => tx.staffAvailability.count({ where: { staffId } }));
    expect(rows).toBe(1);
    await withoutRls((tx) => tx.staffAvailability.deleteMany({ where: { staffId } }));
  });

  it('a membership/role refusal arrives as a readable denial, not a crash', async () => {
    // FRONT_DESK cannot assign ORG_OWNER. This is a privilege-escalation
    // denial: the operator must be told, and the attempt must fail.
    const result = await safeAction('test.updateMemberRole', () =>
      updateMemberRole(deskSession, ownerMembershipId, 'owner'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toBe(GENERIC_ERROR_MESSAGE);
    expect(result.message).not.toMatch(/Minified React error/i);
    expect(result.message.length).toBeGreaterThan(10);

    // Fail-closed: the role did not change.
    const after = await withoutRls((tx) =>
      tx.membership.findUniqueOrThrow({
        where: { id: ownerMembershipId },
        select: { role: true },
      }),
    );
    expect(after.role).toBe('owner');
  });

  it('an ordinary admin mutation returns ok with its payload', async () => {
    const result = await safeAction('test.createLocation', () =>
      createLocation(ownerSession, {
        type: 'clinic',
        name: 'Ordinary Mutation Location',
        timezone: 'Asia/Tbilisi',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.name).toBe('Ordinary Mutation Location');
  });

  it('an unexpected internal failure is generic and leaks nothing', async () => {
    const secret = 'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2';
    const result = await safeAction('test.boom', async () => {
      throw new Error(secret);
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('internal');
    expect(result.message).toBe(GENERIC_ERROR_MESSAGE);
    // Nothing internal survives: no host, no port, no credential, no stack.
    expect(result.message).not.toContain('ECONNREFUSED');
    expect(result.message).not.toContain('10.1.2.3');
    expect(result.message).not.toContain('hunter2');
    expect(result.message).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('maps each domain error class to the same code vocabulary the API uses', async () => {
    const cases: Array<[Error, string]> = [
      [new InvalidInputError('bad input'), 'invalid_input'],
      [new ForbiddenError('not allowed'), 'forbidden'],
      [new ConflictError('conflicting'), 'conflict'],
    ];
    for (const [err, code] of cases) {
      const r = await safeAction('test.map', async () => {
        throw err;
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.code).toBe(code);
      expect(r.message).toBe(err.message);
    }
  });

  // ---------------------------------------------------------------------------
  // The fetch-based half: BreakGlassForm, OrgDetail and PermissionsPanel called
  // API routes and rendered `await res.text()` verbatim, so a 500 printed the
  // internal token {"error":"internal_error"}.
  //
  // Fixtures are built from the envelope `mapError()` in lib/auth.ts actually
  // emits — `{ error: <message> }` with the status it chooses — rather than
  // from resultFromResponse's own shape.
  // ---------------------------------------------------------------------------
  it('break-glass style refusals keep their reason; 5xx never leaks internals', async () => {
    const refusal = new Response(JSON.stringify({ error: 'invalid TOTP code' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
    const refused = await resultFromResponse(refusal);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.code).toBe('forbidden');
    expect(refused.message).toBe('invalid TOTP code');

    // A 500 body is an internal identifier, not a sentence for a human.
    const boom = new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
    const failed = await resultFromResponse(boom);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('unreachable');
    expect(failed.code).toBe('internal');
    expect(failed.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(failed.message).not.toContain('internal_error');
  });

  it('an unparseable error body still produces a sentence', async () => {
    const html = new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 });
    const r = await resultFromResponse(html);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(r.message).not.toContain('<html>');
  });
});
