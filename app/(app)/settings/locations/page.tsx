import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listLocations } from '@/lib/admin';
import LocationsPanel, { type LocationRow } from '@/components/settings/LocationsPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsLocationsPage() {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'org.branch.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
  const rows = await listLocations(ctxToSession(ctx));
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
