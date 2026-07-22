import { requireRole } from '@/lib/auth';
import { listLocations, listStaff } from '@/lib/admin';
import StaffPanel, { type LocationRef, type StaffRow } from '@/components/settings/StaffPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsStaffPage() {
  const session = await requireRole('owner');
  const [staffRows, locationRows] = await Promise.all([
    listStaff(session),
    listLocations(session),
  ]);
  const locations: LocationRef[] = locationRows.map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
  }));
  const staff: StaffRow[] = staffRows.map((s) => ({
    id: s.id,
    locationId: s.locationId,
    locationName: locations.find((l) => l.id === s.locationId)?.name ?? '?',
    name: s.name,
    roleTitle: s.roleTitle,
    specialty: s.specialty,
    email: s.email,
    phone: s.phone,
    calendarColor: s.calendarColor,
    availability: s.availability.map((a) => ({
      weekday: a.weekday,
      startTime: `${String(a.startTime.getUTCHours()).padStart(2, '0')}:${String(
        a.startTime.getUTCMinutes(),
      ).padStart(2, '0')}`,
      endTime: `${String(a.endTime.getUTCHours()).padStart(2, '0')}:${String(
        a.endTime.getUTCMinutes(),
      ).padStart(2, '0')}`,
    })),
  }));
  return <StaffPanel staff={staff} locations={locations} />;
}
