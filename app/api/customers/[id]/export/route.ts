import { NextResponse, type NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth';
import { exportCustomerData } from '@/lib/gdpr';

// POST /api/customers/[id]/export — owner-only. Returns the full PII export
// as a JSON attachment. Writes audit_log('read', 'customer', id, {export}).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole('owner');
  const { id } = await params;
  const data = await exportCustomerData(session, id);
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="customer-${id}-export.json"`,
      'cache-control': 'no-store',
    },
  });
}
