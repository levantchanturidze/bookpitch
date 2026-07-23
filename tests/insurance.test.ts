import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { buildClaimsExport, listInsurers, renderClaimsCsv } = await import(
  '@/lib/insurance'
);
const { isValidIcd10 } = await import('@/lib/icd10');
const { InvalidInputError } = await import('@/lib/auth');

describe('ICD-10 shape validation', () => {
  it('accepts canonical codes', () => {
    for (const c of ['A09', 'I10', 'J06.9', 'L70.0', 'Z00.0']) {
      expect(isValidIcd10(c)).toBe(true);
    }
  });
  it('rejects garbage', () => {
    for (const c of ['', 'ABC', '10', 'J', '123.4', 'J06.']) {
      expect(isValidIcd10(c)).toBe(false);
    }
  });
});

describe('renderClaimsCsv', () => {
  it('quotes commas + doubles internal quotes', () => {
    const csv = renderClaimsCsv([
      {
        claimRef: 'AP-1',
        patientFullName: 'Doe, "Jane"',
        insurer: 'Ardi',
        policyNumber: 'P1',
        serviceDate: '2027-01-01',
        procedure: 'Check',
        amountGel: 40,
        icd10Code: 'Z00.0',
        icd10Description: 'Exam',
        staffName: 'Dr',
        notes: null,
      },
    ]);
    expect(csv.split('\r\n')[0]).toBe(
      'claim_ref,patient_full_name,insurer,policy_number,service_date,procedure,amount_gel,icd10,icd10_description,staff_name,notes',
    );
    expect(csv).toContain('"Doe, ""Jane"""');
    expect(csv).toContain('40.00');
  });
});

describe('buildClaimsExport', () => {
  let orgId: string;
  let ownerId: string;
  let locationId: string;
  let staffId: string;
  let serviceId: string;
  let customerInsured: string;
  let customerUninsured: string;

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `ins-${Date.now()}` } });
      const owner = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `ins-${Date.now()}@ex.dev`,
          email: `ins-${Date.now()}@ex.dev`,
          fullName: 'Ins Owner',
          passwordHash: 'x',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: owner.id, role: 'owner' },
      });
      const location = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'Ins Clinic' },
      });
      const staff = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Ins Doc',
          roleTitle: 'GP',
          specialty: null,
        },
      });
      const service = await tx.service.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Consultation',
          category: 'general',
          price: 45,
          durationMinutes: 30,
        },
      });
      const insured = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'Ins Patient',
          insurerName: 'Ardi Insurance',
          insurancePolicyNumber: 'ARDI-001',
        },
      });
      const uninsured = await tx.customer.create({
        data: { organizationId: org.id, name: 'No Ins Patient' },
      });

      const now = new Date('2027-06-15T10:00:00Z');
      // Included: completed + icd10 + insured customer.
      await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: insured.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt: now,
          endsAt: new Date(now.getTime() + 30 * 60_000),
          serviceName: 'Consultation',
          price: 45,
          status: 'completed',
          icd10Code: 'I10',
          icd10Description: 'Essential (primary) hypertension',
        },
      });
      // Excluded: pending status.
      await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: insured.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt: new Date(now.getTime() + 3600_000),
          endsAt: new Date(now.getTime() + 3600_000 + 30 * 60_000),
          serviceName: 'Consultation',
          price: 45,
          status: 'pending',
          icd10Code: 'I10',
        },
      });
      // Excluded: no ICD.
      await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: insured.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt: new Date(now.getTime() + 2 * 3600_000),
          endsAt: new Date(now.getTime() + 2 * 3600_000 + 30 * 60_000),
          serviceName: 'Consultation',
          price: 45,
          status: 'completed',
        },
      });
      // Excluded: uninsured customer.
      await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: uninsured.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt: new Date(now.getTime() + 3 * 3600_000),
          endsAt: new Date(now.getTime() + 3 * 3600_000 + 30 * 60_000),
          serviceName: 'Consultation',
          price: 45,
          status: 'completed',
          icd10Code: 'I10',
        },
      });
      return { org, owner, location, staff, service, insured, uninsured };
    });
    orgId = seed.org.id;
    ownerId = seed.owner.id;
    locationId = seed.location.id;
    staffId = seed.staff.id;
    serviceId = seed.service.id;
    customerInsured = seed.insured.id;
    customerUninsured = seed.uninsured.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.appointment.deleteMany({ where: { organizationId: orgId } });
      await tx.customer.deleteMany({ where: { organizationId: orgId } });
      await tx.service.delete({ where: { id: serviceId } });
      await tx.staff.delete({ where: { id: staffId } });
      await tx.location.delete({ where: { id: locationId } });
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.appUser.delete({ where: { id: ownerId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  function session() {
    return {
      userId: ownerId,
      organizationId: orgId,
      role: 'owner' as const,
      email: 'ins@example.dev',
    };
  }

  it('listInsurers surfaces distinct insurer names', async () => {
    expect(await listInsurers(session())).toEqual(['Ardi Insurance']);
  });

  it('picks up completed + ICD-coded + insured; excludes the rest', async () => {
    const rows = await buildClaimsExport(session(), {
      from: new Date('2027-06-01T00:00:00Z'),
      to: new Date('2027-07-01T00:00:00Z'),
    });
    expect(rows.length).toBe(1);
    expect(rows[0].icd10Code).toBe('I10');
    expect(rows[0].insurer).toBe('Ardi Insurance');
    expect(rows[0].policyNumber).toBe('ARDI-001');
    expect(rows[0].amountGel).toBe(45);
    expect(rows[0].claimRef).toMatch(/^AP-[0-9A-F]{8}$/);
  });

  it('rejects from >= to', async () => {
    const now = new Date();
    await expect(
      buildClaimsExport(session(), { from: now, to: now }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('filters by insurer when provided', async () => {
    const rows = await buildClaimsExport(session(), {
      from: new Date('2027-06-01T00:00:00Z'),
      to: new Date('2027-07-01T00:00:00Z'),
      insurer: 'Different Insurer',
    });
    expect(rows.length).toBe(0);
  });
});
