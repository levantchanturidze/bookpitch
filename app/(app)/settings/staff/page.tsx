import { ctxToSession } from '@/lib/auth';
import { can, requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { listLocations, listMembers, listStaff } from '@/lib/admin';
import StaffPanel, {
  type LocationRef,
  type MemberOption,
  type StaffRow,
} from '@/components/settings/StaffPanel';
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
  const [staffRows, locationRows, memberRows] = await Promise.all([
    listStaff(session),
    listLocations(session),
    listMembers(session),
  ]);
  // Linking a staff record to a member decides which appointments that member
  // OWNS (`:own`) — the same authority as changing their role. The action
  // enforces it; this only decides whether the control is offered.
  const canLink = can(ctx, 'staff.role.assign', { organizationId: ctx.activeOrganizationId! });
  const members: MemberOption[] = memberRows
    .filter((m) => m.status === 'active')
    .map((m) => ({ userId: m.userId, label: m.fullName ? `${m.fullName} · ${m.email}` : m.email }));
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
      linkedUserId: s.userId,
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
  return <StaffPanel staff={staff} locations={locations} members={members} canLink={canLink} />;
}
