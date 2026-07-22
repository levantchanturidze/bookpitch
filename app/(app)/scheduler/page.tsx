import { requireRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { loadLocationsForOrg } from '@/lib/active-location';
import { toAppointmentDto } from '@/lib/appointments';
import SchedulerView from '@/components/scheduler/SchedulerView';

export const metadata = { title: 'Scheduler · Bookpitch' };

// Server component: fetches the whole month's appointments + supporting
// staff/services/customers for the active location, then hands off to the
// client SchedulerView. Server Actions revalidate this route after each write.
export default async function SchedulerPage() {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)); // give the next month a peek

  const { staff, services, customers, appointments } = await withOrg(
    session.organizationId,
    async (tx) => {
      const [staff, services, customers, rows] = await Promise.all([
        tx.staff.findMany({
          where: { locationId: active.id },
          select: {
            id: true,
            name: true,
            roleTitle: true,
            specialty: true,
            calendarColor: true,
          },
          orderBy: { name: 'asc' },
        }),
        tx.service.findMany({
          where: { locationId: active.id, isActive: true },
          select: { id: true, name: true, price: true, durationMinutes: true },
          orderBy: { name: 'asc' },
        }),
        tx.customer.findMany({
          select: { id: true, name: true, phone: true },
          orderBy: { name: 'asc' },
        }),
        tx.appointment.findMany({
          where: {
            locationId: active.id,
            startsAt: { gte: monthStart, lt: monthEnd },
          },
          include: {
            customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
            staff: { select: { id: true, name: true, roleTitle: true, calendarColor: true } },
          },
          orderBy: { startsAt: 'asc' },
        }),
      ]);
      await writeAudit(tx, session, 'list', 'appointment', null, {
        count: rows.length,
        locationId: active.id,
      });
      return {
        staff,
        services: services.map((s) => ({ ...s, price: Number(s.price) })),
        customers,
        appointments: rows.map(toAppointmentDto),
      };
    },
  );

  return (
    <SchedulerView
      location={{ id: active.id, name: active.name, type: active.type }}
      staff={staff}
      services={services}
      customers={customers}
      appointments={appointments}
      monthAnchorIso={monthStart.toISOString()}
    />
  );
}
