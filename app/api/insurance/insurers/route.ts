import { requireRole, withApi } from '@/lib/auth';
import { listInsurers } from '@/lib/insurance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/insurance/insurers — owner-only. Distinct insurer_name values
// on this org's customers. Used to populate the export page dropdown.
export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    return { insurers: await listInsurers(session) };
  });
}
