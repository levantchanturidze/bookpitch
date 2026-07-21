import { cookies } from 'next/headers';
import { withOrg } from '@/lib/db';
import type { LocationType } from '@prisma/client';

const COOKIE_NAME = 'bookpitch.activeLocationId';

export type ActiveLocation = {
  id: string;
  name: string;
  type: LocationType;
};

/**
 * Returns every location for the caller's organization (used by the switcher)
 * and the currently-active location. Defaults to the first clinic, else the
 * first salon, if no cookie is set OR the cookie points at a stale location.
 *
 * Caller must already be signed in; pass the org id from getSession().
 */
export async function loadLocationsForOrg(orgId: string): Promise<{
  locations: ActiveLocation[];
  active: ActiveLocation;
}> {
  const locations = await withOrg(orgId, (tx) =>
    tx.location.findMany({
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, type: true },
    }),
  );

  if (locations.length === 0) {
    throw new Error(`No locations for org ${orgId}`);
  }

  const jar = await cookies();
  const cookieId = jar.get(COOKIE_NAME)?.value;
  const fromCookie = cookieId ? locations.find((l) => l.id === cookieId) : undefined;

  // Default: prefer a clinic, else fall back to whatever is first.
  const fallback = locations.find((l) => l.type === 'clinic') ?? locations[0];

  return { locations, active: fromCookie ?? fallback };
}

/**
 * Server action for the switcher: writes the cookie and lets the caller
 * decide whether to `revalidatePath` / redirect.
 */
export async function persistActiveLocation(id: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // 30 days is plenty for a UI preference.
    maxAge: 60 * 60 * 24 * 30,
  });
}
