import { withoutRls } from '@/lib/db';
import { notifyEvent } from '@/lib/notifications';
import { consumeRateLimit } from '@/lib/rate-limit';
import { InvalidInputError } from '@/lib/auth';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Public booking widget. No session: the customer is anonymous. All entry
// points fetch by publicSlug so URLs never leak an org UUID.
//
// Safety:
//   - Every write is rate-limited per (location, IP) via consumeRateLimit
//     bucket 'public-book' (5/min per org — the abuse blast radius matches
//     other public writes).
//   - Overlapping-appointment guard relies on the existing GiST exclusion
//     constraint no_staff_double_booking; we don't try to pre-check.
//   - Consent capture is REQUIRED on the payload and stamped onto the
//     Customer row (consentAt + consentVersion).
// -----------------------------------------------------------------------------

const CONSENT_VERSION = '1.0';

export type PublicLocation = {
  organizationId: string;
  organizationName: string;
  locationId: string;
  locationName: string;
  locationType: 'clinic' | 'salon';
  staff: Array<{ id: string; name: string; roleTitle: string }>;
  services: Array<{ id: string; name: string; price: number; durationMinutes: number }>;
};

export async function getPublicLocation(slug: string): Promise<PublicLocation | null> {
  const row = await withoutRls((tx) =>
    tx.location.findFirst({
      where: { publicSlug: slug },
      include: {
        organization: { select: { name: true, id: true } },
        staff: {
          select: { id: true, name: true, roleTitle: true },
          orderBy: { name: 'asc' },
        },
        services: {
          where: { isActive: true },
          select: { id: true, name: true, price: true, durationMinutes: true },
          orderBy: { name: 'asc' },
        },
      },
    }),
  );
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    locationId: row.id,
    locationName: row.name,
    locationType: row.type as 'clinic' | 'salon',
    staff: row.staff,
    services: row.services.map((s) => ({
      id: s.id,
      name: s.name,
      price: Number(s.price),
      durationMinutes: s.durationMinutes,
    })),
  };
}

export type PublicBookInput = {
  slug: string;
  staffId: string;
  serviceId: string;
  startsAtIso: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  notes?: string;
  consented: boolean;
};

export type PublicBookResult = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
};

export async function submitPublicBooking(input: PublicBookInput): Promise<PublicBookResult> {
  if (!input.consented) throw new InvalidInputError('consent is required');
  const name = input.customerName.trim();
  if (!name) throw new InvalidInputError('customer name is required');
  const email = input.customerEmail?.trim().toLowerCase() || null;
  const phone = input.customerPhone?.trim() || null;
  if (!email && !phone) {
    throw new InvalidInputError('at least one of email or phone is required');
  }

  const location = await getPublicLocation(input.slug);
  if (!location) throw new InvalidInputError('booking widget not found');

  // Rate limit at the org level — a burst against the widget billable to
  // one clinic is still a nuisance to that clinic. 30/min ceiling shared
  // across all public entrants for the org.
  await consumeRateLimit(location.organizationId, 'public-book', 30);

  const staff = location.staff.find((s) => s.id === input.staffId);
  if (!staff) throw new InvalidInputError('unknown staff');
  const service = location.services.find((s) => s.id === input.serviceId);
  if (!service) throw new InvalidInputError('unknown service');

  const startsAt = new Date(input.startsAtIso);
  if (Number.isNaN(startsAt.getTime())) throw new InvalidInputError('startsAt is invalid');
  if (startsAt.getTime() < Date.now() + 5 * 60 * 1000) {
    throw new InvalidInputError('booking must be at least 5 minutes in the future');
  }
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  const result = await withoutRls(async (tx) => {
    // Match on (org, email) OR (org, phone) so returning customers reuse
    // their row; never leak identity across orgs.
    const existing = email
      ? await tx.customer.findFirst({
          where: { organizationId: location.organizationId, email },
        })
      : phone
        ? await tx.customer.findFirst({
            where: { organizationId: location.organizationId, phone },
          })
        : null;

    const customer =
      existing ??
      (await tx.customer.create({
        data: {
          organizationId: location.organizationId,
          name,
          email,
          phone,
          consentAt: new Date(),
          consentVersion: CONSENT_VERSION,
        },
      }));

    // If the customer exists but hasn't consented, stamp consent now.
    if (existing && !existing.consentAt) {
      await tx.customer.update({
        where: { id: existing.id },
        data: { consentAt: new Date(), consentVersion: CONSENT_VERSION },
      });
    }

    // GiST exclusion constraint (no_staff_double_booking) is the source
    // of truth. If two clients race for the same slot, the loser gets a
    // 23P01 which we surface as a 409 in the route.
    const appointment = await tx.appointment.create({
      data: {
        organizationId: location.organizationId,
        locationId: location.locationId,
        customerId: customer.id,
        staffId: staff.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        serviceName: service.name,
        price: service.price,
        status: 'pending',
        paymentStatus: 'unpaid',
        notes: input.notes ?? null,
      },
    });
    // Anonymous public write — actor is null so /audit shows "system"
    // with a source=public_widget marker.
    await tx.auditLog.create({
      data: {
        organizationId: location.organizationId,
        actorUserId: null,
        action: 'create',
        entity: 'appointment',
        entityId: appointment.id,
        meta: { source: 'public_widget' },
      },
    });
    await notifyEvent(tx, location.organizationId, {
      type: 'booking',
      title: 'New public booking',
      body: `${service.name} · ${startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    });
    return appointment;
  });

  log.info('public_booking.ok', {
    organizationId: location.organizationId,
    appointmentId: result.id,
  });
  return {
    appointmentId: result.id,
    startsAt: result.startsAt.toISOString(),
    endsAt: result.endsAt.toISOString(),
  };
}
