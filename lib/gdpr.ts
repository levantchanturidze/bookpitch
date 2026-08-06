import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg, withoutRls } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import { decryptField } from '@/lib/crypto';

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
// -----------------------------------------------------------------------------
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
        email: null,
        phone: null,
        dob: null,
        gender: null,
        avatarUrl: null,
        allergies: null,
        clinicalNotes: null,
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

    const now = new Date();
    const cutoff = new Date(
      now.getFullYear() - org.customerRetentionYears,
      now.getMonth(),
      now.getDate(),
    );

    const candidates = await tx.customer.findMany({
      where: {
        organizationId,
        updatedAt: { lt: cutoff },
        // Not already redacted (name would start with the sentinel).
        name: { not: { startsWith: 'Redacted Customer #' } },
      },
      select: {
        id: true,
        name: true,
        appointments: { where: { startsAt: { gte: cutoff } }, select: { id: true }, take: 1 },
      },
    });

    const stale = candidates.filter((c) => c.appointments.length === 0);

    const anonymizedIds: string[] = [];
    for (const c of stale) {
      const suffix = c.id.slice(0, 8);
      await tx.customer.update({
        where: { id: c.id },
        data: {
          name: `Redacted Customer #${suffix}`,
          email: null,
          phone: null,
          dob: null,
          gender: null,
          avatarUrl: null,
          allergies: null,
          clinicalNotes: null,
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
      cutoff: cutoff.toISOString(),
      anonymizedCount: anonymizedIds.length,
      anonymizedIds,
    };
  });
}
