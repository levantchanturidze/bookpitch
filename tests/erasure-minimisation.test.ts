import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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
const { anonymizeCustomer, runRetentionTick, REDACTED_MESSAGE_FIELD } = await import('@/lib/gdpr');
const { erasedNamePseudonym } = await import('@/lib/crypto');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { requireAuthContext } = await import('@/lib/rbac');
const { ctxToSession } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// Erasure leaves nothing that identifies the person, outside the two records
// /privacy says survive (the append-only audit log and treatment history).
//
// Before: both erasure paths cleared the customer columns only. The customer's
// waitlist entries (free-text notes about the patient) and their reminder
// delivery records (recipient address; a message body carrying the name)
// survived. And the erasure copied the name into two NEW records: the
// append-only audit log (`previousName`, never erasable again) and a staff
// notification.
// -----------------------------------------------------------------------------
const stamp = Date.now();
const NAME = `Erasure Target ${stamp}`;
const EMAIL = `erasure-target-${stamp}@bp.test`;
const PHONE = '+995500000222';
const CONTROL = `Control Customer ${stamp}`;
const fx = {
  org: '',
  owner: '',
  loc: '',
  staff: '',
  target: '',
  control: '',
  retired: '',
};
const RETIRED = `Retired Customer ${stamp}`;

async function waitlistFor(customerId: string, note: string) {
  return (
    await withoutRls((tx) =>
      tx.waitlist.create({
        data: {
          organizationId: fx.org,
          customerId,
          locationId: fx.loc,
          preferredFrom: new Date('2031-05-01T00:00:00Z'),
          preferredTo: new Date('2031-05-31T00:00:00Z'),
          notes: note,
        },
        select: { id: true },
      }),
    )
  ).id;
}
async function deliveredReminder(customerId: string, startsAt: Date, to: string, who: string) {
  return withoutRls(async (tx) => {
    const appt = await tx.appointment.create({
      data: {
        organizationId: fx.org,
        locationId: fx.loc,
        customerId,
        staffId: fx.staff,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        serviceName: 'Erasure check',
        price: 10,
        status: 'completed',
      },
      select: { id: true },
    });
    const log = await tx.messageLog.create({
      data: {
        organizationId: fx.org,
        appointmentId: appt.id,
        channel: 'email',
        toAddress: to,
        body: `Hi ${who}, see you soon`,
        state: 'sent',
        sentAt: startsAt,
      },
      select: { id: true },
    });
    return { appt: appt.id, log: log.id };
  });
}
const auditJson = async () =>
  JSON.stringify(
    await unsafePrismaAdmin.auditLog.findMany({
      where: { organizationId: fx.org },
      select: { action: true, entity: true, entityId: true, meta: true },
    }),
  );

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    // Archived: a live ownerless organisation breaks the ownership invariant.
    const org = await tx.organization.create({
      data: { name: `erasure-${stamp}`, status: 'archived' },
      select: { id: true },
    });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `erasure-owner-${stamp}@bp.test`,
        email: `erasure-owner-${stamp}@bp.test`,
      },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: role.id },
    });
    const loc = await tx.location.create({
      data: { organizationId: org.id, name: 'E', type: 'clinic', timezone: 'UTC' },
      select: { id: true },
    });
    const staff = await tx.staff.create({
      data: { organizationId: org.id, locationId: loc.id, name: 'E Dr', roleTitle: 'GP' },
      select: { id: true },
    });
    // updatedAt is backdated on INSERT: set_updated_at rewrites it on UPDATE.
    const customer = async (name: string, email: string | null, updatedAt?: Date) =>
      (
        await tx.customer.create({
          data: { organizationId: org.id, name, email, phone: email ? PHONE : null, updatedAt },
          select: { id: true },
        })
      ).id;
    return {
      org: org.id,
      owner: owner.id,
      loc: loc.id,
      staff: staff.id,
      target: await customer(NAME, EMAIL),
      control: await customer(CONTROL, `control-${stamp}@bp.test`),
      // Idle past the organisation's retention window (default 7 years).
      retired: await customer(
        RETIRED,
        `retired-${stamp}@bp.test`,
        new Date('2015-01-01T00:00:00Z'),
      ),
    };
  });
  Object.assign(fx, seeded);
});

afterAll(async () => {
  await withoutRls(async (tx) => {
    await tx.messageLog.deleteMany({ where: { organizationId: fx.org } });
    await tx.waitlist.deleteMany({ where: { organizationId: fx.org } });
    await tx.notification.deleteMany({ where: { organizationId: fx.org } });
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

describe('a redaction on request leaves no copy of the person', () => {
  it('removes waitlist entries, clears delivery records, and copies the name nowhere', async () => {
    const w1 = await waitlistFor(fx.target, `${NAME} prefers mornings`);
    const w2 = await waitlistFor(fx.target, 'knee surgery follow-up');
    const wControl = await waitlistFor(fx.control, `${CONTROL} any time`);
    const mine = await deliveredReminder(fx.target, new Date('2026-09-01T09:00:00Z'), EMAIL, NAME);
    const theirs = await deliveredReminder(
      fx.control,
      new Date('2026-09-01T10:00:00Z'),
      `control-${stamp}@bp.test`,
      CONTROL,
    );

    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(fx.owner, fx.org));
    const session = ctxToSession(await requireAuthContext());
    await anonymizeCustomer(session, fx.target, 'gdpr');

    // The waitlist entries are gone, each audited without its notes.
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id: { in: [w1, w2] } } })).toBe(0);
    const removed = await unsafePrismaAdmin.auditLog.findMany({
      where: { organizationId: fx.org, entity: 'waitlist', entityId: { in: [w1, w2] } },
      select: { action: true, actorUserId: true, meta: true },
    });
    expect(removed).toHaveLength(2);
    for (const r of removed) {
      expect(r.action).toBe('delete');
      expect(r.actorUserId).toBe(fx.owner);
      expect(r.meta).toMatchObject({ customerId: fx.target, reason: 'customer_redacted' });
    }

    // The delivery record says a reminder was sent, and when, but not to whom.
    const log = await unsafePrismaAdmin.messageLog.findUniqueOrThrow({ where: { id: mine.log } });
    expect(log.toAddress).toBe(REDACTED_MESSAGE_FIELD);
    expect(log.body).toBe(REDACTED_MESSAGE_FIELD);
    expect(log.state).toBe('sent');
    expect(log.channel).toBe('email');
    expect(log.sentAt).not.toBeNull();

    // The erasure's own audit row: a pseudonym and counts, not the name.
    const own = await unsafePrismaAdmin.auditLog.findFirstOrThrow({
      where: { organizationId: fx.org, entity: 'customer', entityId: fx.target },
      select: { meta: true },
    });
    expect(own.meta).toEqual({
      reason: 'gdpr',
      previousNameHmac: erasedNamePseudonym(NAME),
      waitlistEntriesRemoved: 2,
      messagesCleared: 1,
    });
    const audit = await auditJson();
    for (const pii of [NAME, EMAIL, PHONE, 'prefers mornings', 'knee surgery']) {
      expect(audit, pii).not.toContain(pii);
    }
    const notes = await unsafePrismaAdmin.notification.findMany({
      where: { organizationId: fx.org, title: 'Customer anonymized' },
      select: { body: true },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).not.toContain(NAME);

    // COMPLEMENT: another customer of the same organisation is untouched.
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id: wControl } })).toBe(1);
    const other = await unsafePrismaAdmin.messageLog.findUniqueOrThrow({
      where: { id: theirs.log },
    });
    expect(other.toAddress).toBe(`control-${stamp}@bp.test`);
    expect(other.body).toContain(CONTROL);
  });

  it('the pseudonym confirms a claimed name and rejects another', () => {
    expect(erasedNamePseudonym(`  ${NAME.toUpperCase()} `)).toBe(erasedNamePseudonym(NAME));
    expect(erasedNamePseudonym(CONTROL)).not.toBe(erasedNamePseudonym(NAME));
  });
});

describe('the retention tick leaves no copy of the person either', () => {
  it('removes waitlist entries, clears delivery records, and audits a pseudonym (system actor)', async () => {
    const w = await waitlistFor(fx.retired, `${RETIRED} call before noon`);
    const old = await deliveredReminder(
      fx.retired,
      new Date('2015-01-05T09:00:00Z'),
      `retired-${stamp}@bp.test`,
      RETIRED,
    );
    const report = await runRetentionTick(fx.org);
    expect(report.anonymizedIds).toContain(fx.retired);

    expect(await unsafePrismaAdmin.waitlist.count({ where: { id: w } })).toBe(0);
    const entryAudit = await unsafePrismaAdmin.auditLog.findFirstOrThrow({
      where: { organizationId: fx.org, entity: 'waitlist', entityId: w },
      select: { actorUserId: true, meta: true },
    });
    expect(entryAudit.actorUserId).toBeNull();
    expect(entryAudit.meta).toMatchObject({ reason: 'customer_redacted' });

    const log = await unsafePrismaAdmin.messageLog.findUniqueOrThrow({ where: { id: old.log } });
    expect([log.toAddress, log.body]).toEqual([REDACTED_MESSAGE_FIELD, REDACTED_MESSAGE_FIELD]);

    const own = await unsafePrismaAdmin.auditLog.findFirstOrThrow({
      where: { organizationId: fx.org, entity: 'customer', entityId: fx.retired },
      select: { meta: true },
    });
    expect(own.meta).toEqual({
      reason: 'retention',
      previousNameHmac: erasedNamePseudonym(RETIRED),
      waitlistEntriesRemoved: 1,
      messagesCleared: 1,
    });
    const audit = await auditJson();
    for (const pii of [RETIRED, `retired-${stamp}@bp.test`, 'call before noon']) {
      expect(audit, pii).not.toContain(pii);
    }
  });
});
