import { redirect } from 'next/navigation';
import Shell from '@/components/shell/Shell';
import { requireSession } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { loadLocationsForOrg } from '@/lib/active-location';

/**
 * Layout for every authed route. Middleware guarantees a session exists;
 * requireSession() is a redundant safety net.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let session;
  try {
    session = await requireSession();
  } catch {
    // Belt-and-braces if middleware ever misses.
    redirect('/signin');
  }

  const [organization, { locations, active }] = await Promise.all([
    withOrg(session.organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: session.organizationId },
        select: { name: true },
      }),
    ),
    loadLocationsForOrg(session.organizationId), // redirects to /signin if empty
  ]);

  if (!organization) redirect('/signin');

  return (
    <Shell
      session={{ email: session.email, role: session.role }}
      organizationName={organization.name}
      locations={locations}
      activeLocation={active}
    >
      {children}
    </Shell>
  );
}
