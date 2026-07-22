import { requireRole } from '@/lib/auth';
import { listLocations } from '@/lib/admin';
import LocationsPanel, { type LocationRow } from '@/components/settings/LocationsPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsLocationsPage() {
  const session = await requireRole('owner');
  const rows = await listLocations(session);
  const locations: LocationRow[] = rows.map((l) => ({
    id: l.id,
    type: l.type,
    name: l.name,
    timezone: l.timezone,
    taxRate: Number(l.taxRate),
    counts: {
      staff: l._count.staff,
      appointments: l._count.appointments,
      services: l._count.services,
    },
  }));
  return <LocationsPanel locations={locations} />;
}
