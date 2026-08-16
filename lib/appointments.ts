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
import { localDayRange, localDateWeekday, toLocalDate, toLocalTimeHHMM } from '@/lib/tz';
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

/**
 * Convert a raw Appointment DB row to the display DTO.
 *
 * `timezone` should be the IANA timezone of the appointment's location.
 * When omitted the fields default to UTC strings so callers that cannot
 * easily supply the timezone (API routes, legacy code) stay correct in the
 * sense that they're consistent — they're just UTC-labelled, not local.
 * All scheduler / booking paths supply the timezone explicitly.
 */
export function toAppointmentDto(
  row: Appointment & {
    customer: Pick<Customer, 'id' | 'name' | 'phone' | 'avatarUrl'>;
    staff: Pick<Staff, 'id' | 'name' | 'roleTitle' | 'calendarColor'>;
  },
  timezone = 'UTC',
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
    date: toLocalDate(row.startsAt, timezone),
    time: toLocalTimeHHMM(row.startsAt, timezone),
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
// Returns HH:MM strings in the location's LOCAL timezone for open slots on
// `date` (also a local YYYY-MM-DD in the same timezone). Step derives from
// durationMinutes: min(durationMinutes, 30) so a 15-min service offers every
// 15 minutes rather than every 30.
//
// Availability windows constrain the range when configured; 07:00–21:00 LOCAL
// is the fallback when no windows exist (fail-open, same as assertWithinAvailability).
//
// Slots that overlap with existing non-cancelled appointments are excluded.
// Day boundaries use the local calendar day of the location's timezone so a
// clinic in UTC−5 doesn't miss late-afternoon appointments that fall in the
// next UTC date.
//
// This is UX filtering only — the GiST exclusion constraint remains the
// authoritative double-booking guard for race conditions.
// -----------------------------------------------------------------------------
export async function getAvailableSlots(
  tx: TxClient,
  staffId: string,
  date: string, // YYYY-MM-DD in the location's local timezone
  durationMinutes: number,
  timezone = 'UTC', // IANA timezone of the location
): Promise<string[]> {
  const weekday = localDateWeekday(date, timezone);
  const { start: dayStart, end: dayEnd } = localDayRange(date, timezone);

  const windows = await tx.staffAvailability.findMany({
    where: { staffId, weekday },
    select: { startTime: true, endTime: true },
  });

  // Availability windows are stored as UTC time-of-day values (1970-01-01T<HH:MM>Z).
  // Convert to local minutes for comparison with local slot start times.
  const ranges =
    windows.length === 0
      ? [{ startMin: 7 * 60, endMin: 21 * 60 }] // default working day (local)
      : windows.map((w) => {
          const localStart = utcTimeValueToLocalMin(w.startTime, timezone);
          const localEnd = utcTimeValueToLocalMin(w.endTime, timezone);
          return { startMin: localStart, endMin: localEnd };
        });

  const booked = await tx.appointment.findMany({
    where: {
      staffId,
      status: { not: 'cancelled' },
      startsAt: { gte: dayStart, lt: dayEnd },
    },
    select: { startsAt: true, endsAt: true },
  });

  // Convert booked appointment times to local minutes for overlap comparison.
  const bookedIntervals = booked.map((a) => {
    const startLocal = toLocalTimeHHMM(a.startsAt, timezone).split(':').map(Number);
    const endLocal = toLocalTimeHHMM(a.endsAt, timezone).split(':').map(Number);
    return {
      startMin: startLocal[0] * 60 + startLocal[1],
      endMin: endLocal[0] * 60 + endLocal[1],
    };
  });

  // Step derives from service duration so sub-30-min services don't lose slots.
  const step = Math.min(durationMinutes, 30);

  const slots: string[] = [];
  for (const range of ranges) {
    for (let t = range.startMin; t + durationMinutes <= range.endMin; t += step) {
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

/** Internal: convert a Prisma Time DB value to local minutes-since-midnight. */
function utcTimeValueToLocalMin(utcTime: Date, tz: string): number {
  const localHHMM = toLocalTimeHHMM(
    // Rebase to today to avoid 1970 historical DST data
    (() => {
      const today = new Date();
      return new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate(),
          utcTime.getUTCHours(),
          utcTime.getUTCMinutes(),
          0,
        ),
      );
    })(),
    tz,
  );
  const [h, m] = localHHMM.split(':').map(Number);
  return h * 60 + m;
}
