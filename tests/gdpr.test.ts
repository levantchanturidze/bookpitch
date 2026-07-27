import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { encryptField } = await import('@/lib/crypto');
const { anonymizeCustomer, exportCustomerData, runRetentionTick } = await import('@/lib/gdpr');
const { queryAudit } = await import('@/lib/audit-query');

type Session = {
  organizationId: string;
  userId: string;
  email: string;
  role: 'owner';
};

describe('GDPR + audit-query', () => {
  let orgId: string;
  let userId: string;
  let customerA: string; // anonymize target
  let customerB: string; // export target (kept)
  let customerC: string; // retention target (old)
  const cleanup: Array<() => Promise<void>> = [];
  let session: Session;

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({
        data: { name: 'GDPR Fixture Org', customerRetentionYears: 2 },
      });
      const location = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'GDPR Clinic' },
      });
      const service = await tx.service.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'GDPR fixture service',
          price: 50,
          durationMinutes: 30,
        },
      });
      const staff = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'GDPR Staff',
          roleTitle: 'Fixture',
        },
      });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: 'gdpr-owner@bookpitch.dev',
          email: 'gdpr-owner@bookpitch.dev',
        },
      });

      // A — will be anonymized.
      const custA = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'Anon Target',
          email: 'anon@example.dev',
          phone: '+995 000 1',
          allergies: encryptField('Peanuts'),
          clinicalNotes: encryptField('Notes for A'),
        },
      });

      // B — will be exported (with an appointment + payment + message log).
      const custB = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'Export Target',
          email: 'export@example.dev',
          phone: '+995 000 2',
          allergies: encryptField('Latex'),
        },
      });
      const apptB = await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: custB.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt: new Date('2027-01-01T10:00Z'),
          endsAt: new Date('2027-01-01T10:30Z'),
          serviceName: service.name,
          price: 50,
          status: 'confirmed',
          paymentStatus: 'paid',
        },
      });
      await tx.payment.create({
        data: {
          organizationId: org.id,
          appointmentId: apptB.id,
          method: 'cash',
          amount: 50,
          currency: 'GEL',
          status: 'paid',
          paidAt: new Date('2027-01-01T10:30Z'),
        },
      });
      await tx.messageLog.create({
        data: {
          organizationId: org.id,
          appointmentId: apptB.id,
          channel: 'sms',
          toAddress: '+995 000 2',
          body: 'reminder text',
          state: 'sent',
        },
      });

      // C — old, no recent appointments; retention tick should sweep it.
      // Backdate updatedAt directly on INSERT — the set_updated_at trigger
      // only fires BEFORE UPDATE, so a raw INSERT keeps our value.
      const backdated = new Date();
      backdated.setFullYear(backdated.getFullYear() - 5);
      const custC = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'Retention Target',
          email: 'retention@example.dev',
          allergies: encryptField('Nickel'),
          updatedAt: backdated,
        },
      });

      cleanup.push(async () => {
        await withoutRls((tx) => tx.messageLog.deleteMany({ where: { appointmentId: apptB.id } }));
        await withoutRls((tx) => tx.payment.deleteMany({ where: { appointmentId: apptB.id } }));
        await withoutRls((tx) => tx.appointment.delete({ where: { id: apptB.id } }));
        await withoutRls((tx) =>
          tx.customer.deleteMany({ where: { id: { in: [custA.id, custB.id, custC.id] } } }),
        );
        await withoutRls((tx) => tx.staff.delete({ where: { id: staff.id } }));
        await withoutRls((tx) => tx.service.delete({ where: { id: service.id } }));
        await withoutRls((tx) => tx.location.delete({ where: { id: location.id } }));
        // audit_log is append-only in prod (spec §9.11); dev-only escape
        // hatch releases the FK grip on the fixture user + org.
        const { resetAuditForOrgs } = await import('./helpers/audit-reset');
        await resetAuditForOrgs([org.id]);
        await withoutRls((tx) => tx.appUser.delete({ where: { id: user.id } }));
        await withoutRls((tx) => tx.organization.delete({ where: { id: org.id } }));
      });

      return {
        orgId: org.id,
        userId: user.id,
        custA: custA.id,
        custB: custB.id,
        custC: custC.id,
      };
    });
    orgId = seed.orgId;
    userId = seed.userId;
    customerA = seed.custA;
    customerB = seed.custB;
    customerC = seed.custC;
    session = {
      organizationId: orgId,
      userId,
      email: 'gdpr-owner@bookpitch.dev',
      role: 'owner',
    };
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) {
      await step().catch(() => null);
    }
  });

  it('export bundles customer + related rows + decrypts sensitive fields', async () => {
    const bundle = await exportCustomerData(session, customerB);
    expect(bundle.customer.name).toBe('Export Target');
    expect(bundle.customer.allergies).toBe('Latex'); // decrypted
    expect(bundle.appointments.length).toBe(1);
    expect(bundle.payments.length).toBe(1);
    expect(bundle.messageLog.length).toBe(1);
    expect(bundle.customer.email).toBe('export@example.dev');
    expect(bundle.customer.phone).toBe('+995 000 2');
  });

  it('anonymize redacts PII in place and writes an audit_log delete row', async () => {
    await anonymizeCustomer(session, customerA, 'gdpr');
    const after = await withoutRls((tx) =>
      tx.customer.findUnique({ where: { id: customerA } }),
    );
    expect(after?.name.startsWith('Redacted Customer #')).toBe(true);
    expect(after?.email).toBeNull();
    expect(after?.phone).toBeNull();
    expect(after?.allergies).toBeNull();
    expect(after?.clinicalNotes).toBeNull();

    const audit = await withoutRls((tx) =>
      tx.auditLog.findFirst({
        where: { entity: 'customer', entityId: customerA, action: 'delete' },
        orderBy: { at: 'desc' },
      }),
    );
    expect(audit).toBeTruthy();
    expect((audit?.meta as { reason?: string } | null)?.reason).toBe('gdpr');
  });

  it('retention tick anonymizes stale customers and leaves fresh ones alone', async () => {
    const report = await runRetentionTick(orgId);
    expect(report.anonymizedIds).toContain(customerC);
    expect(report.anonymizedIds).not.toContain(customerB);

    const afterC = await withoutRls((tx) => tx.customer.findUnique({ where: { id: customerC } }));
    expect(afterC?.name.startsWith('Redacted Customer #')).toBe(true);

    const afterB = await withoutRls((tx) => tx.customer.findUnique({ where: { id: customerB } }));
    expect(afterB?.name).toBe('Export Target'); // untouched — has recent appointment
  });

  it('audit-query filters by customerId + action', async () => {
    const rows = await withoutRls((tx) =>
      queryAudit(tx, { customerId: customerA, action: 'delete' }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.entityId === customerA && r.action === 'delete')).toBe(true);
  });
});
