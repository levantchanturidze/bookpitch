import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { consumeReset } = await import('@/lib/auth/password-reset');
const { deleteStaff } = await import('@/lib/admin');
const { InvalidInputError, ctxToSession } = await import('@/lib/auth');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { requireAuthContext } = await import('@/lib/rbac');

// -----------------------------------------------------------------------------
// Expiry is judged by the DATABASE clock, the one the expiry is set by and the
// one housekeeping sweeps by. This process's clock is faked to be wrong by two
// hours (only `Date`, so the database driver's timers keep running), which is
// the only way the difference is observable.
// -----------------------------------------------------------------------------
const stamp = Date.now();
const HOURS_2 = 2 * 3_600_000;
function skewProcessClock(byMs: number) {
  const realNow = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(realNow + byMs));
}
afterEach(() => {
  vi.useRealTimers();
});

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
async function plantToken(email: string, raw: string, expiresSql: 'past' | 'future') {
  const offset = expiresSql === 'past' ? "- interval '1 minute'" : "+ interval '30 minutes'";
  await unsafePrismaAdmin.$executeRawUnsafe(
    `INSERT INTO verification_tokens (identifier, token, expires)
     VALUES ($1, $2, transaction_timestamp() ${offset})`,
    email,
    sha(raw),
  );
}

describe('a password-reset link expires by the database clock', () => {
  const email = `clock-reset-${stamp}@bp.test`;
  let userId = '';
  const hashOf = async () =>
    (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true },
      })
    ).passwordHash;

  beforeAll(async () => {
    userId = (
      await withoutRls((tx) =>
        tx.appUser.create({
          data: {
            authProvider: 'credentials',
            authSubject: email,
            email,
            passwordHash: 'original-hash',
          },
          select: { id: true },
        }),
      )
    ).id;
  });
  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.verificationToken.deleteMany({ where: { identifier: email } });
      await tx.appUser.deleteMany({ where: { id: userId } });
    });
  });

  it('a link the database says has expired is refused, with this process two hours behind', async () => {
    const raw = `expired-by-db-${stamp}-xxxxxxxxxxxx`;
    await plantToken(email, raw, 'past');
    skewProcessClock(-HOURS_2);
    await expect(
      consumeReset({ token: raw, newPassword: 'a-new-password-123' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    vi.useRealTimers();
    expect(await hashOf()).toBe('original-hash');
  });

  it('COMPLEMENT: a live link works, with this process two hours ahead', async () => {
    const raw = `live-by-db-${stamp}-xxxxxxxxxxxxxxxx`;
    await plantToken(email, raw, 'future');
    skewProcessClock(HOURS_2);
    await expect(consumeReset({ token: raw, newPassword: 'a-new-password-456' })).resolves.toEqual({
      userId,
    });
    vi.useRealTimers();
    expect(await hashOf()).not.toBe('original-hash');
  });

  it('two simultaneous uses of one link: exactly one succeeds, the other is refused cleanly', async () => {
    const raw = `raced-${stamp}-xxxxxxxxxxxxxxxxxxxxxx`;
    await plantToken(email, raw, 'future');
    const outcomes = await Promise.allSettled([
      consumeReset({ token: raw, newPassword: 'first-password-111' }),
      consumeReset({ token: raw, newPassword: 'second-password-222' }),
    ]);
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // A refusal, not an unhandled database error (it was a P2025 from deleting
    // a token the winner had already deleted, i.e. a 500).
    expect(refused[0].reason).toBeInstanceOf(InvalidInputError);
    expect(await unsafePrismaAdmin.verificationToken.count({ where: { token: sha(raw) } })).toBe(0);
  });
});

describe("deleting a provider is judged by the database clock's 'future'", () => {
  const fx = { org: '', owner: '', staff: '' };

  beforeAll(async () => {
    const seeded = await withoutRls(async (tx) => {
      const role = await tx.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null },
        select: { id: true },
      });
      // Archived: a live ownerless organisation breaks the ownership invariant.
      const org = await tx.organization.create({
        data: { name: `clock-staff-${stamp}`, status: 'archived' },
        select: { id: true },
      });
      const owner = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `clock-owner-${stamp}@bp.test`,
          email: `clock-owner-${stamp}@bp.test`,
        },
        select: { id: true },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: role.id },
      });
      const loc = await tx.location.create({
        data: { organizationId: org.id, name: 'C', type: 'clinic', timezone: 'UTC' },
        select: { id: true },
      });
      const staff = await tx.staff.create({
        data: { organizationId: org.id, locationId: loc.id, name: 'C Dr', roleTitle: 'GP' },
        select: { id: true },
      });
      const customer = await tx.customer.create({
        data: { organizationId: org.id, name: 'C Customer' },
        select: { id: true },
      });
      // Starts 30 minutes from the DATABASE's now.
      await tx.$executeRaw`
        INSERT INTO appointments (organization_id, location_id, customer_id, staff_id,
                                  starts_at, ends_at, service_name, price, status)
        VALUES (${org.id}::uuid, ${loc.id}::uuid, ${customer.id}::uuid, ${staff.id}::uuid,
                transaction_timestamp() + interval '30 minutes',
                transaction_timestamp() + interval '60 minutes', 'Clock', 10, 'confirmed')`;
      return { org: org.id, owner: owner.id, staff: staff.id };
    });
    Object.assign(fx, seeded);
  });
  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.appointment.deleteMany({ where: { organizationId: fx.org } });
      await tx.customer.deleteMany({ where: { organizationId: fx.org } });
      await tx.staff.deleteMany({ where: { organizationId: fx.org } });
      await tx.location.deleteMany({ where: { organizationId: fx.org } });
      await tx.membership.deleteMany({ where: { organizationId: fx.org } });
    });
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([fx.org]);
    await withoutRls(async (tx) => {
      await tx.appUser.deleteMany({ where: { id: fx.owner } });
      await tx.organization.deleteMany({ where: { id: fx.org } });
    });
  });

  it('a booking 30 minutes away is a FUTURE booking, with this process two hours ahead', async () => {
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(fx.owner, fx.org));
    const session = ctxToSession(await requireAuthContext());
    skewProcessClock(HOURS_2);
    // The foreign key (onDelete: Restrict) refuses either way; this is about the
    // RULE the user is told: spec §9 rule 5, not "has appointments".
    await expect(deleteStaff(session, fx.staff)).rejects.toThrow(/1 future booking/);
    vi.useRealTimers();
    expect(await unsafePrismaAdmin.staff.count({ where: { id: fx.staff } })).toBe(1);
  });
});
