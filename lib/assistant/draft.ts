import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { assertStaffAtLocation, assertWithinAvailability, loadServiceForLocation } from '@/lib/appointments';
import { getAssistant, type AssistantContext, type AssistantResult } from './model';
import { consumeAssistantQuota } from './quota';

// -----------------------------------------------------------------------------
// draftAppointment — the server pipeline the /api and Server Action call.
// 1) Load org context (staff + services + short customer list) inside withOrg.
// 2) Ask the adapter to interpret the prompt.
// 3) If draft: validate against the same assertStaffAtLocation +
//    assertWithinAvailability the real booking uses. Do NOT insert — the
//    actual write happens in bookAppointmentAction so the GiST exclusion
//    constraint stays the source of truth for double-booking.
// -----------------------------------------------------------------------------

export type ValidatedDraft = Extract<AssistantResult, { status: 'draft' }> & {
  durationMinutes: number | null;
};

export type DraftAppointmentResult =
  | { status: 'draft'; draft: ValidatedDraft }
  | { status: 'clarify'; question: string };

export async function draftAppointment(
  session: ActiveSession,
  locationId: string,
  prompt: string,
  referenceDate: Date = new Date(),
): Promise<DraftAppointmentResult> {
  if (!prompt || prompt.trim().length < 3) {
    throw new InvalidInputError('prompt is too short');
  }

  // Reserve one call against the monthly cap BEFORE loading org context —
  // otherwise a rate-limited caller could still enumerate customers.
  await consumeAssistantQuota(session.organizationId);

  const ctx: AssistantContext = await withOrg(session.organizationId, async (tx) => {
    const location = await tx.location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true, type: true },
    });
    if (!location) throw new InvalidInputError('location not found');
    const [staff, services, customers] = await Promise.all([
      tx.staff.findMany({
        where: { locationId },
        select: { id: true, name: true, roleTitle: true, specialty: true },
      }),
      tx.service.findMany({
        where: { locationId, isActive: true },
        select: { id: true, name: true, durationMinutes: true, price: true },
      }),
      tx.customer.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      }),
    ]);
    return {
      referenceDate: referenceDate.toISOString(),
      location: { id: location.id, name: location.name, type: location.type },
      staff,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.durationMinutes,
        price: Number(s.price),
      })),
      customers,
    };
  });

  const result = await getAssistant().draft(prompt, ctx);
  if (result.status === 'clarify') return result;

  // Validate the draft against the same rules the real bookAppointment path
  // uses. Warnings are additive, not fatal — we still return the draft so
  // the operator can adjust before confirming.
  const draft = result;
  const warnings = [...draft.warnings];
  let durationMinutes: number | null = null;

  try {
    await withOrg(session.organizationId, async (tx) => {
      if (draft.staffId) {
        await assertStaffAtLocation(tx, locationId, draft.staffId);
      }
      if (draft.serviceId) {
        const service = await loadServiceForLocation(tx, locationId, draft.serviceId);
        durationMinutes = service.durationMinutes;
      }
      if (draft.staffId && durationMinutes !== null) {
        const startsAt = new Date(draft.startsAt);
        const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
        await assertWithinAvailability(tx, draft.staffId, startsAt, endsAt);
      }
    });
  } catch (err) {
    // Convert validation misses into surfacing warnings, not thrown errors —
    // the operator can pick a better slot from the draft card.
    warnings.push(
      (err as Error).message === 'slot_outside_availability'
        ? "This slot is outside the staff member's availability window."
        : (err as Error).message,
    );
  }

  return {
    status: 'draft',
    draft: { ...draft, warnings, durationMinutes },
  };
}
