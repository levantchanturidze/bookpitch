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
const { anonymizeCustomer, runRetentionTick, CUSTOMER_REDACTION_FIELDS } =
  await import('@/lib/gdpr');
const { buildClaimsExport } = await import('@/lib/insurance');

// -----------------------------------------------------------------------------
// P15-002 — erasure completeness.
//
// Both erasure paths (an explicit GDPR request via anonymizeCustomer, and the
// scheduled retention sweep via runRetentionTick) previously cleared
// name/email/phone/dob/gender/avatar/allergies/clinicalNotes but left
// insurerName and insurancePolicyNumber populated. A policy number is
// directly identifying, so the "erased" customer stayed identifiable — and
// because buildClaimsExport() filters on `insurancePolicyNumber: { not: null }`
// they kept appearing in insurance claim exports by name and policy number.
//
// These tests assert the OBSERVABLE consequence (disappearance from the claims
// export), not merely that the columns are null. Asserting the columns alone
// would still pass if the export later started reading the data from
// somewhere else.
// -----------------------------------------------------------------------------

type Session = {
  organizationId: string;
  userId: string;
  email: string;
  role: 'owner';
};

const RANGE_FROM = new Date('2027-03-01T00:00:00Z');
const RANGE_TO = new Date('2027-04-01T00:00:00Z');

describe('P15-002 erasure clears every identifying customer column', () => {
  let session: Session;
  let orgId: string;
  let gdprCustomer: string;
  let retentionCustomer: string;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({
        data: { name: 'E2E-PHASE15-erasure-org', customerRetentionYears: 2 },
      });
      const location = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'E2E-PHASE15-clinic' },
      });
      const service = await tx.service.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'E2E-PHASE15-service',
          price: 80,
          durationMinutes: 30,
        },
      });
      const staff = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'E2E-PHASE15-staff',
          roleTitle: 'Fixture',
        },
      });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: 'e2e-phase15-erasure@bookpitch.dev',
          email: 'e2e-phase15-erasure@bookpitch.dev',
        },
      });

      // Insured patient erased by an explicit GDPR request.
      const gdpr = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'E2E-PHASE15 Gdpr Patient',
          email: 'e2e-phase15-gdpr@example.dev',
          phone: '+995 555 0101',
          dob: new Date('1990-05-04'),
          gender: 'f',
          allergies: encryptField('Penicillin'),
          clinicalNotes: encryptField('Fixture note'),
          insurerName: 'E2E-PHASE15 Insurer',
          insurancePolicyNumber: 'E2E-PHASE15-POLICY-0001',
        },
      });

      // Insured patient swept by the retention tick: stale updatedAt, no
      // appointment inside the retention window.
      const backdated = new Date();
      backdated.setFullYear(backdated.getFullYear() - 6);
      const retention = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'E2E-PHASE15 Retention Patient',
          email: 'e2e-phase15-retention@example.dev',
          insurerName: 'E2E-PHASE15 Insurer',
          insurancePolicyNumber: 'E2E-PHASE15-POLICY-0002',
          updatedAt: backdated,
        },
      });

      // A completed, coded appointment is what puts the GDPR patient into the
      // claims export. Dated inside RANGE so the export picks it up.
      const appt = await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: gdpr.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt: new Date('2027-03-10T09:00:00Z'),
          endsAt: new Date('2027-03-10T09:30:00Z'),
          serviceName: service.name,
          price: 80,
          status: 'completed',
          paymentStatus: 'paid',
          icd10Code: 'Z00.0',
          icd10Description: 'General examination',
        },
      });

      cleanup.push(async () => {
        await withoutRls((tx) => tx.appointment.deleteMany({ where: { id: appt.id } }));
        await withoutRls((tx) =>
          tx.customer.deleteMany({ where: { id: { in: [gdpr.id, retention.id] } } }),
        );
        await withoutRls((tx) => tx.staff.deleteMany({ where: { id: staff.id } }));
        await withoutRls((tx) => tx.service.deleteMany({ where: { id: service.id } }));
        await withoutRls((tx) => tx.location.deleteMany({ where: { id: location.id } }));
        const { resetAuditForOrgs } = await import('./helpers/audit-reset');
        await resetAuditForOrgs([org.id]);
        await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: user.id } }));
        await withoutRls((tx) => tx.organization.deleteMany({ where: { id: org.id } }));
      });

      return { orgId: org.id, userId: user.id, gdpr: gdpr.id, retention: retention.id };
    });

    orgId = seed.orgId;
    gdprCustomer = seed.gdpr;
    retentionCustomer = seed.retention;
    session = {
      organizationId: orgId,
      userId: seed.userId,
      email: 'e2e-phase15-erasure@bookpitch.dev',
      role: 'owner',
    };
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => null);
  });

  it('lists the insured patient in the claims export before erasure', async () => {
    const rows = await buildClaimsExport(session, { from: RANGE_FROM, to: RANGE_TO });
    const mine = rows.filter((r) => r.policyNumber === 'E2E-PHASE15-POLICY-0001');
    expect(mine).toHaveLength(1);
    expect(mine[0].patientFullName).toBe('E2E-PHASE15 Gdpr Patient');
  });

  it('drops the patient from the claims export after a GDPR erasure', async () => {
    await anonymizeCustomer(session, gdprCustomer, 'gdpr');

    const rows = await buildClaimsExport(session, { from: RANGE_FROM, to: RANGE_TO });
    // The observable outcome: no claim row can still carry the policy number
    // or the patient's real name.
    expect(rows.some((r) => r.policyNumber === 'E2E-PHASE15-POLICY-0001')).toBe(false);
    expect(rows.some((r) => r.patientFullName === 'E2E-PHASE15 Gdpr Patient')).toBe(false);
  });

  it('nulls insurer and policy number on the erased row itself', async () => {
    const row = await withoutRls((tx) =>
      tx.customer.findUnique({
        where: { id: gdprCustomer },
        select: {
          name: true,
          email: true,
          phone: true,
          dob: true,
          gender: true,
          allergies: true,
          clinicalNotes: true,
          insurerName: true,
          insurancePolicyNumber: true,
        },
      }),
    );
    expect(row?.name.startsWith('Redacted Customer #')).toBe(true);
    expect(row?.insurerName).toBeNull();
    expect(row?.insurancePolicyNumber).toBeNull();
    // Every column the shared constant claims to clear is actually cleared.
    for (const field of Object.keys(CUSTOMER_REDACTION_FIELDS)) {
      expect(row?.[field as keyof typeof row] ?? null).toBeNull();
    }
  });

  it('retention sweep clears insurance data too, not just contact details', async () => {
    const report = await runRetentionTick(orgId);
    expect(report.anonymizedIds).toContain(retentionCustomer);

    const row = await withoutRls((tx) =>
      tx.customer.findUnique({
        where: { id: retentionCustomer },
        select: { name: true, email: true, insurerName: true, insurancePolicyNumber: true },
      }),
    );
    expect(row?.name.startsWith('Redacted Customer #')).toBe(true);
    expect(row?.email).toBeNull();
    expect(row?.insurerName).toBeNull();
    expect(row?.insurancePolicyNumber).toBeNull();
  });

  it('keeps the two erasure paths on one shared field set', () => {
    // Guards the drift that caused P15-002: if a new identifying column is
    // added to one path only, this constant is the single place to change.
    expect(Object.keys(CUSTOMER_REDACTION_FIELDS).sort()).toEqual(
      [
        'allergies',
        'avatarUrl',
        'clinicalNotes',
        'dob',
        'email',
        'gender',
        'insurancePolicyNumber',
        'insurerName',
        'phone',
      ].sort(),
    );
  });
});
