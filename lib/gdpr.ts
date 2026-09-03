import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg, withoutRls } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import { decryptField } from '@/lib/crypto';
import { retentionCutoffSql } from '@/lib/retention-window';

// -----------------------------------------------------------------------------
// GDPR-style tooling: per-customer data export, per-customer anonymize
// ("delete" in GDPR terms — the row itself stays so FK-linked appointments
// and payments remain coherent), and a retention tick that anonymizes
// customers whose PII has been idle past the org's retention window.
// -----------------------------------------------------------------------------

const ANON_REASONS = ['gdpr', 'retention', 'admin'] as const;
export type AnonymizeReason = (typeof ANON_REASONS)[number];

export type CustomerExport = {
  exportedAt: string;
  organizationId: string;
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    dob: string | null;
    gender: string | null;
    joinedDate: string;
    allergies: string | null; // decrypted
    clinicalNotes: string | null; // decrypted
    consentAt: string | null;
    consentVersion: string | null;
    createdAt: string;
    updatedAt: string;
  };
  treatmentHistory: Array<{ id: string; label: string; occurredOn: string | null }>;
  appointments: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    paymentStatus: string;
    serviceName: string;
    price: number;
    staffName: string;
  }>;
  payments: Array<{
    id: string;
    method: string;
    status: string;
    amount: number;
    currency: string;
    paidAt: string | null;
  }>;
  messageLog: Array<{
    id: string;
    channel: string;
    state: string;
    toAddress: string;
    sentAt: string | null;
  }>;
};

// -----------------------------------------------------------------------------
// Export — collects everything PII-adjacent about one customer.
// -----------------------------------------------------------------------------
export async function exportCustomerData(
  session: ActiveSession,
  customerId: string,
): Promise<CustomerExport> {
  return withOrg(session.organizationId, async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      include: {
        treatmentHistory: { orderBy: { createdAt: 'asc' } },
        appointments: {
          orderBy: { startsAt: 'asc' },
          include: { staff: { select: { name: true } } },
        },
      },
    });
    if (!customer) throw new InvalidInputError('customer not found');

    const payments = await tx.payment.findMany({
      where: { appointmentId: { in: customer.appointments.map((a) => a.id) } },
      orderBy: { createdAt: 'asc' },
    });
    const messages = await tx.messageLog.findMany({
      where: { appointmentId: { in: customer.appointments.map((a) => a.id) } },
      orderBy: { createdAt: 'asc' },
    });

    await writeAudit(tx, session, 'read', 'customer', customerId, { export: true });

    return {
      exportedAt: new Date().toISOString(),
      organizationId: session.organizationId,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        dob: customer.dob ? customer.dob.toISOString().slice(0, 10) : null,
        gender: customer.gender,
        joinedDate: customer.joinedDate.toISOString().slice(0, 10),
        allergies: decryptField(customer.allergies),
        clinicalNotes: decryptField(customer.clinicalNotes),
        consentAt: customer.consentAt?.toISOString() ?? null,
        consentVersion: customer.consentVersion,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      },
      treatmentHistory: customer.treatmentHistory.map((h) => ({
        id: h.id,
        label: h.label,
        occurredOn: h.occurredOn ? h.occurredOn.toISOString().slice(0, 10) : null,
      })),
      appointments: customer.appointments.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        status: a.status,
        paymentStatus: a.paymentStatus,
        serviceName: a.serviceName,
        price: Number(a.price),
        staffName: a.staff.name,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        method: p.method,
        status: p.status,
        amount: Number(p.amount),
        currency: p.currency,
        paidAt: p.paidAt?.toISOString() ?? null,
      })),
      messageLog: messages.map((m) => ({
        id: m.id,
        channel: m.channel,
        state: m.state,
        toAddress: m.toAddress,
        sentAt: m.sentAt?.toISOString() ?? null,
      })),
    };
  });
}

// -----------------------------------------------------------------------------
// Anonymize — redact PII in place. FK-linked appointments/payments still
// resolve; audit trail preserves the operational history.
//
// P15-002: the redaction field set lives here, in one place, because it was
// previously duplicated between anonymizeCustomer() and runRetentionTick().
// The two copies drifted: both cleared name/email/phone/dob/gender/avatar/
// allergies/clinicalNotes but neither cleared insurerName or
// insurancePolicyNumber. A policy number is directly identifying, and
// buildClaimsExport() in lib/insurance.ts selects on
// `insurancePolicyNumber: { not: null }` — so an erased customer kept
// reappearing in insurance claim exports under their real policy number.
// One shared constant means the two paths cannot drift again.
//
// Deliberately NOT cleared here: treatment_history rows. Those are clinical
// records and may carry a statutory retention duty that outlives an erasure
// request; removing them is a legal decision, not an engineering one. Tracked
// as P15-005 in docs/phase-15-launch-readiness-uat-ledger.md and flagged for
// the legal review in docs/legal-review-checklist.md. Do not "fix" this
// without that decision.
// -----------------------------------------------------------------------------

/**
 * Every customer column that holds directly-identifying or special-category
 * personal data and must be cleared by both erasure paths.
 *
 * Exported so tests can assert the set is actually applied rather than
 * re-listing the fields (a test that restates the constant proves nothing).
 */
export const CUSTOMER_REDACTION_FIELDS = {
  email: null,
  phone: null,
  dob: null,
  gender: null,
  avatarUrl: null,
  allergies: null,
  clinicalNotes: null,
  insurerName: null,
  insurancePolicyNumber: null,
} as const;

export async function anonymizeCustomer(
  session: ActiveSession,
  customerId: string,
  reason: AnonymizeReason,
): Promise<void> {
  if (!ANON_REASONS.includes(reason)) throw new InvalidInputError('invalid reason');

  await withOrg(session.organizationId, async (tx) => {
    const existing = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true },
    });
    if (!existing) throw new InvalidInputError('customer not found');

    // Preserve a short suffix so the redacted row is still individually
    // findable in operational logs.
    const suffix = existing.id.slice(0, 8);
    await tx.customer.update({
      where: { id: customerId },
      data: {
        name: `Redacted Customer #${suffix}`,
        ...CUSTOMER_REDACTION_FIELDS,
      },
    });
    await writeAudit(tx, session, 'delete', 'customer', customerId, {
      reason,
      previousName: existing.name,
    });
    await notifyEvent(tx, session.organizationId, {
      type: 'system',
      title: 'Customer anonymized',
      body: `${existing.name} → Redacted Customer #${suffix} (${reason})`,
    });
  });
}

// -----------------------------------------------------------------------------
// Retention tick — bulk-anonymize customers past the org's retention window.
// A customer is "idle" when both:
//   - customer.updatedAt is older than N years, AND
//   - no appointment starts_at within the last N years.
// -----------------------------------------------------------------------------
export type RetentionReport = {
  organizationId: string;
  retentionYears: number;
  cutoff: string;
  anonymizedCount: number;
  anonymizedIds: string[];
};

export async function runRetentionTick(organizationId: string): Promise<RetentionReport> {
  return withoutRls(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { customerRetentionYears: true },
    });
    if (!org) throw new InvalidInputError('organization not found');

    // The cutoff is computed by PostgreSQL, not by Node. It used to be
    // new Date(now.getFullYear() - N, now.getMonth(), now.getDate()) — local
    // -time accessors, so on a host at +04 the day boundary moves four hours
    // early and customers are redacted up to a day before the organization's
    // policy permits. Redaction is irreversible. See lib/retention-window.ts.
    const cutoffExpr = retentionCutoffSql(`${org.customerRetentionYears}`);
    const stale = await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT c.id, c.name
         FROM customers c
        WHERE c.organization_id = $1::uuid
          AND c.updated_at < ${cutoffExpr}
          -- Not already redacted (name carries the sentinel).
          AND c.name NOT LIKE 'Redacted Customer #%'
          -- No appointment inside the window keeps the record live.
          AND NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.customer_id = c.id
                   AND a.starts_at >= ${cutoffExpr}
              )`,
      organizationId,
    );

    // Reported for the audit trail, read back from the same expression that
    // selected the rows so the two can never drift.
    const cutoffRow = await tx.$queryRawUnsafe<Array<{ cutoff: Date }>>(
      `SELECT ${cutoffExpr} AS cutoff`,
    );
    const cutoff = cutoffRow[0].cutoff;

    const anonymizedIds: string[] = [];
    for (const c of stale) {
      const suffix = c.id.slice(0, 8);
      await tx.customer.update({
        where: { id: c.id },
        data: {
          name: `Redacted Customer #${suffix}`,
          ...CUSTOMER_REDACTION_FIELDS,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          action: 'delete',
          entity: 'customer',
          entityId: c.id,
          meta: { reason: 'retention', previousName: c.name },
        },
      });
      anonymizedIds.push(c.id);
    }

    return {
      organizationId,
      retentionYears: org.customerRetentionYears,
      cutoff: new Date(cutoff).toISOString(),
      anonymizedCount: anonymizedIds.length,
      anonymizedIds,
    };
  });
}
