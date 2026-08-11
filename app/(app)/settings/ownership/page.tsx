import { requireAuthContext } from '@/lib/rbac';
import {
  pendingTransfersForNominee,
  pendingTransfersFromNominator,
} from '@/lib/admin/ownership-transfer';
import OwnershipPanel from '@/components/settings/OwnershipPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsOwnershipPage() {
  const ctx = await requireAuthContext();
  const [incoming, outgoing] = await Promise.all([
    pendingTransfersForNominee(ctx.userId),
    pendingTransfersFromNominator(ctx.userId),
  ]);
  return <OwnershipPanel incoming={incoming} outgoing={outgoing} />;
}
