import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { listLocations, listStaff } from '@/lib/admin';
import StaffPanel, { type LocationRef, type StaffRow } from '@/components/settings/StaffPanel';
import { availabilityHHMM } from '@/lib/availability-basis';

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
        // Read by the row's own basis: legacy rows are still UTC until the
        // normalisation step runs, and both must display local wall-clock time.
        startTime: availabilityHHMM(a.startTime, a.timeBasis, locTz),
        endTime: availabilityHHMM(a.endTime, a.timeBasis, locTz),
      })),
    };
  });
  return <StaffPanel staff={staff} locations={locations} />;
}
