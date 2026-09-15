import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { listLocations, listStaff } from '@/lib/admin';
import StaffPanel, { type LocationRef, type StaffRow } from '@/components/settings/StaffPanel';
/** Read the stored wall-clock digits back out of a Prisma Time column. */
function hhmm(t: Date): string {
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

export const dynamic = 'force-dynamic';

export default async function SettingsStaffPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'staff.update',
    { organizationId: ctx.activeOrganizationId! },
    'admin',
  );
  const session = ctxToSession(ctx);
  const [staffRows, locationRows] = await Promise.all([listStaff(session), listLocations(session)]);
  const locations: LocationRef[] = locationRows.map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    timezone: l.timezone,
  }));
  const staff: StaffRow[] = staffRows.map((s) => {
    const locTz = locations.find((l) => l.id === s.locationId)?.timezone ?? 'UTC';
    return {
      id: s.id,
      locationId: s.locationId,
      locationName: locations.find((l) => l.id === s.locationId)?.name ?? '?',
      name: s.name,
      roleTitle: s.roleTitle,
      specialty: s.specialty,
      email: s.email,
      phone: s.phone,
      calendarColor: s.calendarColor,
      // Times are converted to the location's local timezone for display.
      // setAvailabilityAction converts them back to UTC before storage.
      availability: s.availability.map((a) => ({
        weekday: a.weekday,
        // Already local — stored that way since the availability migration.
        // Converting here as well would shift every window by the offset twice.
        startTime: hhmm(a.startTime),
        endTime: hhmm(a.endTime),
      })),
    };
  });
  return <StaffPanel staff={staff} locations={locations} />;
}
