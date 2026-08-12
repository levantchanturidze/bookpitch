import type {
  Appointment,
  AppointmentStatus,
  Customer,
  PaymentStatus,
  PrismaClient,
  Service,
  Staff,
} from '@prisma/client';
import { InvalidInputError, SlotTakenError } from '@/lib/auth';
import { isValidIcd10 } from '@/lib/icd10';
export { SlotTakenError };

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// DTOs — appointments joined with the bits calendar UIs need.
// -----------------------------------------------------------------------------
export type AppointmentDto = {
  id: string;
  locationId: string;
  customerId: string;
  staffId: string;
  serviceId: string | null;
  startsAt: string;
  endsAt: string;
  date: string; // YYYY-MM-DD (UTC)
  time: string; // HH:MM (UTC)
  durationMinutes: number;
  serviceName: string;
  price: number;
  status: AppointmentStatus;
  paymentStatus: PaymentStatus;
  notes: string | null;
  customer: { id: string; name: string; phone: string | null; avatarUrl: string | null };
  staff: { id: string; name: string; roleTitle: string; calendarColor: string | null };
};

export function toAppointmentDto(
  row: Appointment & {
    customer: Pick<Customer, 'id' | 'name' | 'phone' | 'avatarUrl'>;
    staff: Pick<Staff, 'id' | 'name' | 'roleTitle' | 'calendarColor'>;
  },
): AppointmentDto {
  const durationMs = row.endsAt.getTime() - row.startsAt.getTime();
  return {
    id: row.id,
    locationId: row.locationId,
    customerId: row.customerId,
    staffId: row.staffId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    date: row.startsAt.toISOString().slice(0, 10),
    time: row.startsAt.toISOString().slice(11, 16),
    durationMinutes: Math.round(durationMs / 60_000),
    serviceName: row.serviceName,
    price: Number(row.price),
    status: row.status,
    paymentStatus: row.paymentStatus,
    notes: row.notes,
    customer: row.customer,
    staff: row.staff,
  };
}

// -----------------------------------------------------------------------------
// Input parsing.
// -----------------------------------------------------------------------------
export type AppointmentCreateInput = {
  locationId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
  startsAt: string; // ISO string
  notes?: string | null;
};

export type AppointmentUpdateInput = {
  startsAt?: string;
  staffId?: string;
  serviceId?: string;
  status?: AppointmentStatus;
  paymentStatus?: PaymentStatus;
  notes?: string | null;
  icd10Code?: string | null;
  icd10Description?: string | null;
};

function requireUuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) {
    throw new InvalidInputError(`${field} must be a uuid`);
  }
  return v;
}

function requireIso(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new InvalidInputError(`${field} must be an ISO date string`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new InvalidInputError(`${field} is not a valid date`);
  return d.toISOString();
}

export function parseCreateInput(body: unknown): AppointmentCreateInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;
  return {
    locationId: requireUuid(b.locationId, 'locationId'),
    customerId: requireUuid(b.customerId, 'customerId'),
    staffId: requireUuid(b.staffId, 'staffId'),
    serviceId: requireUuid(b.serviceId, 'serviceId'),
    startsAt: requireIso(b.startsAt, 'startsAt'),
    notes: typeof b.notes === 'string' ? b.notes.trim() || null : null,
  };
}

const VALID_STATUS: AppointmentStatus[] = ['pending', 'confirmed', 'completed', 'cancelled'];
const VALID_PAYMENT: PaymentStatus[] = ['unpaid', 'paid', 'refunding', 'refunded'];

export function parseUpdateInput(body: unknown): AppointmentUpdateInput {
  if (!body || typeof body !== 'object') throw new InvalidInputError('body must be an object');
  const b = body as Record<string, unknown>;
  const out: AppointmentUpdateInput = {};
  if (b.startsAt !== undefined) out.startsAt = requireIso(b.startsAt, 'startsAt');
  if (b.staffId !== undefined) out.staffId = requireUuid(b.staffId, 'staffId');
  if (b.serviceId !== undefined) out.serviceId = requireUuid(b.serviceId, 'serviceId');
  if (b.status !== undefined) {
    if (!VALID_STATUS.includes(b.status as AppointmentStatus)) {
      throw new InvalidInputError(`status must be one of ${VALID_STATUS.join(', ')}`);
    }
    out.status = b.status as AppointmentStatus;
  }
  if (b.paymentStatus !== undefined) {
    if (!VALID_PAYMENT.includes(b.paymentStatus as PaymentStatus)) {
      throw new InvalidInputError(`paymentStatus must be one of ${VALID_PAYMENT.join(', ')}`);
    }
    out.paymentStatus = b.paymentStatus as PaymentStatus;
  }
  if (b.notes !== undefined) {
    out.notes = typeof b.notes === 'string' ? b.notes.trim() || null : null;
  }
  if (b.icd10Code !== undefined) {
    const raw = typeof b.icd10Code === 'string' ? b.icd10Code.trim() : '';
    if (raw && !isValidIcd10(raw)) throw new InvalidInputError('icd10Code shape is invalid');
    out.icd10Code = raw || null;
  }
  if (b.icd10Description !== undefined) {
    out.icd10Description =
      typeof b.icd10Description === 'string' ? b.icd10Description.trim() || null : null;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Validation helpers — run before the write. The DB is still the source of
// truth for double-booking (via the GiST exclusion constraint from P1.1); these
// helpers catch the shallow errors early so the client gets a clean message.
// -----------------------------------------------------------------------------

export async function loadServiceForLocation(
  tx: TxClient,
  locationId: string,
  serviceId: string,
): Promise<Service> {
  const service = await tx.service.findFirst({
    where: { id: serviceId, locationId, isActive: true },
  });
  if (!service) throw new InvalidInputError('service does not exist at this location');
  return service;
}

export async function assertStaffAtLocation(
  tx: TxClient,
  locationId: string,
  staffId: string,
): Promise<void> {
  const staff = await tx.staff.findFirst({
    where: { id: staffId, locationId },
    select: { id: true },
  });
  if (!staff) throw new InvalidInputError('staff does not work at this location');
}

export async function assertCustomerInOrg(tx: TxClient, customerId: string): Promise<void> {
  // RLS already scopes this — if it returns null, the customer isn't in
  // the caller's org.
  const c = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!c) throw new InvalidInputError('customer not found');
}

/**
 * Throws InvalidInputError if [startsAt, endsAt] doesn't fit inside any of
 * the staff's availability windows for that UTC weekday. Skipped entirely if
 * the staff has no windows configured (fail-open per prototype behaviour).
 */
export async function assertWithinAvailability(
  tx: TxClient,
  staffId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<void> {
  const weekday = startsAt.getUTCDay();
  const windows = await tx.staffAvailability.findMany({
    where: { staffId, weekday },
    select: { startTime: true, endTime: true },
  });
  if (windows.length === 0) return; // no configured windows → fall through

  const slotStartMin = startsAt.getUTCHours() * 60 + startsAt.getUTCMinutes();
  const slotEndMin =
    endsAt.getUTCHours() * 60 +
    endsAt.getUTCMinutes() +
    // If the appointment crosses midnight, adjust; usually not needed.
    (endsAt.getUTCDate() !== startsAt.getUTCDate() ? 24 * 60 : 0);

  const fits = windows.some((w) => {
    const wStart = w.startTime.getUTCHours() * 60 + w.startTime.getUTCMinutes();
    const wEnd = w.endTime.getUTCHours() * 60 + w.endTime.getUTCMinutes();
    return slotStartMin >= wStart && slotEndMin <= wEnd;
  });

  if (!fits) throw new InvalidInputError('slot_outside_availability');
}

// -----------------------------------------------------------------------------
// Prisma surfaces the GiST exclusion constraint violation with pg SQLSTATE
// 23P01. Detect it here; callers translate to SlotTakenError (409).
// -----------------------------------------------------------------------------
export function isExclusionViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  if (!e) return false;
  // Prisma wraps 23P01 in PrismaClientUnknownRequestError; the SQLSTATE and
  // constraint name appear in the message string. Also check .meta.code in
  // case a future Prisma version promotes it to PrismaClientKnownRequestError.
  if (e.code === '23P01') return true;
  if (e.meta?.code === '23P01') return true;
  if (typeof e.message === 'string' && e.message.includes('no_staff_double_booking')) return true;
  if (typeof e.message === 'string' && e.message.includes('exclusion constraint')) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Available-slot computation — UX pre-filter for the booking form.
//
// Returns HH:MM UTC strings for open 30-minute slots on `date` for a given
// staff member. Availability windows constrain the range when configured;
// 07:00–21:00 UTC is the fallback when no windows exist (same fail-open logic
// as assertWithinAvailability). Slots that overlap with existing non-cancelled
// appointments are excluded.
//
// This is UX filtering only — the GiST exclusion constraint remains the
// authoritative double-booking guard for race conditions.
// -----------------------------------------------------------------------------
export async function getAvailableSlots(
  tx: TxClient,
  staffId: string,
  date: string, // YYYY-MM-DD UTC
  durationMinutes: number,
): Promise<string[]> {
  const dateObj = new Date(date + 'T00:00:00Z');
  const weekday = dateObj.getUTCDay();
  const dayStart = dateObj.getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const windows = await tx.staffAvailability.findMany({
    where: { staffId, weekday },
    select: { startTime: true, endTime: true },
  });
  const ranges =
    windows.length === 0
      ? [{ startMin: 7 * 60, endMin: 21 * 60 }] // default working day
      : windows.map((w) => ({
          startMin: w.startTime.getUTCHours() * 60 + w.startTime.getUTCMinutes(),
          endMin: w.endTime.getUTCHours() * 60 + w.endTime.getUTCMinutes(),
        }));

  const booked = await tx.appointment.findMany({
    where: {
      staffId,
      status: { not: 'cancelled' },
      startsAt: { gte: new Date(dayStart), lt: new Date(dayEnd) },
    },
    select: { startsAt: true, endsAt: true },
  });
  const bookedIntervals = booked.map((a) => ({
    startMin: a.startsAt.getUTCHours() * 60 + a.startsAt.getUTCMinutes(),
    endMin: a.endsAt.getUTCHours() * 60 + a.endsAt.getUTCMinutes(),
  }));

  const slots: string[] = [];
  for (const range of ranges) {
    for (let t = range.startMin; t + durationMinutes <= range.endMin; t += 30) {
      const slotEnd = t + durationMinutes;
      const taken = bookedIntervals.some((b) => t < b.endMin && slotEnd > b.startMin);
      if (!taken) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
    }
  }
  return slots;
}
