import { ConflictError, InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Production cleanup accepts identifiers only. Names, prefixes and wildcard
 * matching are deliberately not part of this API: a typo must fail closed
 * rather than widen a destructive operation.
 */
export function requireExactCleanupId(id: string, label = 'id'): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new InvalidInputError(`${label} must be an exact uuid`);
  }
  return id;
}

/**
 * Preserve service history when the service has ever been booked.
 * Appointments snapshot name/price, but their service_id is still useful
 * provenance; hard-deleting a referenced service needlessly severs it through
 * ON DELETE SET NULL. Unreferenced services can be deleted safely.
 */
export async function cleanupServiceById(session: ActiveSession, serviceId: string) {
  const id = requireExactCleanupId(serviceId, 'serviceId');
  return withOrg(session.organizationId, async (tx) => {
    const service = await tx.service.findUnique({
      where: { id },
      select: { id: true, isActive: true, _count: { select: { appointments: true } } },
    });
    if (!service) throw new InvalidInputError('service not found');

    if (service._count.appointments > 0) {
      if (service.isActive) {
        await tx.service.update({ where: { id }, data: { isActive: false } });
        await writeAudit(tx, session, 'update', 'service', id, {
          lifecycle: 'deactivated',
          reason: 'appointment_history',
        });
      }
      return { disposition: 'deactivated' as const };
    }

    await tx.service.delete({ where: { id } });
    await writeAudit(tx, session, 'delete', 'service', id, {
      lifecycle: 'deleted_unreferenced',
    });
    return { disposition: 'deleted' as const };
  });
}

/**
 * Staff has an ON DELETE RESTRICT appointment relation and no archive column.
 * Make that lifecycle explicit before calling the legacy delete path: history
 * is never erased. A future product migration may add an active flag; until
 * then the safe outcome is a clear conflict, not a cascading workaround.
 */
export async function assertStaffHardDeleteSafe(session: ActiveSession, staffId: string) {
  const id = requireExactCleanupId(staffId, 'staffId');
  return withOrg(session.organizationId, async (tx) => {
    const staff = await tx.staff.findUnique({
      where: { id },
      select: { id: true, _count: { select: { appointments: true } } },
    });
    if (!staff) throw new InvalidInputError('staff not found');
    if (staff._count.appointments > 0) {
      throw new ConflictError(
        `Staff has ${staff._count.appointments} appointment record(s); preserve history instead of hard-deleting it.`,
      );
    }
    return id;
  });
}
