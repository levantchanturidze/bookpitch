import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listLocations, listServices } from '@/lib/admin';
import ServicesPanel, { type ServiceRow } from '@/components/settings/ServicesPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsServicesPage() {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'service.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
  const session = ctxToSession(ctx);
  const [rows, locations] = await Promise.all([listServices(session), listLocations(session)]);
  const services: ServiceRow[] = rows.map((s) => ({
    id: s.id,
    locationId: s.locationId,
    locationName: locations.find((l) => l.id === s.locationId)?.name ?? '?',
    name: s.name,
    category: s.category,
    price: Number(s.price),
    durationMinutes: s.durationMinutes,
    isActive: s.isActive,
  }));
  return (
    <ServicesPanel
      services={services}
      locations={locations.map((l) => ({ id: l.id, name: l.name, type: l.type, timezone: l.timezone }))}
    />
  );
}
