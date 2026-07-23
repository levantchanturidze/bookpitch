import { withOrg } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';

// -----------------------------------------------------------------------------
// Insurance claim export.
//
// Georgian insurers all accept a broadly similar row shape:
//   claim_ref, patient_full_name, insurer, policy_number, service_date,
//   procedure, amount_gel, icd10, staff_name, notes
//
// buildClaimsExport(session, {from, to, insurer?}) walks completed
// appointments in the window that have both an ICD-10 code AND a
// customer with insurance carrier + policy number, and returns the
// rows ready to render as CSV. Owner-only at the route layer.
// -----------------------------------------------------------------------------

export type ClaimRow = {
  claimRef: string;
  patientFullName: string;
  insurer: string;
  policyNumber: string;
  serviceDate: string;
  procedure: string;
  amountGel: number;
  icd10Code: string;
  icd10Description: string | null;
  staffName: string;
  notes: string | null;
};

export type BuildInput = {
  from: Date;
  to: Date;
  insurer?: string | null;
};

export async function listInsurers(session: ActiveSession): Promise<string[]> {
  return withOrg(session.organizationId, async (tx) => {
    const rows = await tx.customer.findMany({
      where: { insurerName: { not: null } },
      select: { insurerName: true },
      distinct: ['insurerName'],
      orderBy: { insurerName: 'asc' },
    });
    return rows.map((r) => r.insurerName!).filter(Boolean);
  });
}

export async function buildClaimsExport(
  session: ActiveSession,
  input: BuildInput,
): Promise<ClaimRow[]> {
  if (input.from >= input.to) throw new InvalidInputError('from must be before to');
  return withOrg(session.organizationId, async (tx) => {
    const rows = await tx.appointment.findMany({
      where: {
        status: 'completed',
        startsAt: { gte: input.from, lt: input.to },
        icd10Code: { not: null },
        customer: {
          insurerName: input.insurer ? input.insurer : { not: null },
          insurancePolicyNumber: { not: null },
        },
      },
      include: {
        customer: {
          select: {
            name: true,
            insurerName: true,
            insurancePolicyNumber: true,
          },
        },
        staff: { select: { name: true } },
      },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r) => ({
      // Claim ref = short appointment id — stable + unique per visit.
      claimRef: `AP-${r.id.slice(0, 8).toUpperCase()}`,
      patientFullName: r.customer.name,
      insurer: r.customer.insurerName!,
      policyNumber: r.customer.insurancePolicyNumber!,
      serviceDate: r.startsAt.toISOString().slice(0, 10),
      procedure: r.serviceName,
      amountGel: Number(r.price),
      icd10Code: r.icd10Code!,
      icd10Description: r.icd10Description,
      staffName: r.staff.name,
      notes: r.notes,
    }));
  });
}

// CSV renderer. Uses RFC 4180 quoting: enclose fields containing "," " or
// newline in double quotes and escape internal " by doubling it.
export function renderClaimsCsv(rows: ClaimRow[]): string {
  const header = [
    'claim_ref',
    'patient_full_name',
    'insurer',
    'policy_number',
    'service_date',
    'procedure',
    'amount_gel',
    'icd10',
    'icd10_description',
    'staff_name',
    'notes',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.claimRef,
        r.patientFullName,
        r.insurer,
        r.policyNumber,
        r.serviceDate,
        r.procedure,
        r.amountGel.toFixed(2),
        r.icd10Code,
        r.icd10Description ?? '',
        r.staffName,
        r.notes ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
