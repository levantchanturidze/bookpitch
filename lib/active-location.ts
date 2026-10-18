import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withOrg } from '@/lib/db';
import { navigableLocationIds } from '@/lib/rbac/scope';
import type { AuthContext } from '@/lib/rbac/types';
import type { LocationType } from '@prisma/client';

const COOKIE_NAME = 'bookpitch.activeLocationId';

export type ActiveLocation = {
  id: string;
  name: string;
  type: LocationType;
  timezone: string;
};

/**
 * The locations this CALLER may switch between (used by the switcher), and the
 * currently-active one. Defaults to the first clinic, else the first location,
 * if no cookie is set OR the cookie names a location outside that set.
 *
 * Scoped by navigableLocationIds(): it used to return every location of the
 * organisation to every member, so a receptionist scoped to branch A was
 * offered branch B by name and, on switching, an empty view — and a stale or
 * hand-set cookie could make an out-of-scope location the active one (scoped-
 * RBAC audit §7). The cookie is a preference, never an authority: it is honoured
 * only when it names a location in the caller's set, re-decided on every
 * request, so narrowing a member's branches takes effect on their next page.
 *
 * `active` is null when the caller reaches NO location — a branch-scoped member
 * whose branch set is empty. Pages render an explicit "no location assigned"
 * state for that instead of an empty view; this used to be impossible because
 * every member saw every location.
 *
 * An organisation with no locations at all still bounces to /signin, as
 * before. redirect() throws NEXT_REDIRECT, so that path never returns.
 */
export async function loadLocationsForCaller(ctx: AuthContext): Promise<{
  locations: ActiveLocation[];
  active: ActiveLocation | null;
}> {
  const orgId = ctx.activeOrganizationId;
  if (!orgId) redirect('/signin');

  const [all, allowed] = await Promise.all([
    withOrg(orgId, (tx) =>
      tx.location.findMany({
        orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, type: true, timezone: true },
      }),
    ),
    navigableLocationIds(ctx),
  ]);

  // Session references an org with no locations (probably deleted). Bounce
  // to /signin so the user gets a fresh JWT.
  if (all.length === 0) redirect('/signin');

  const locations = allowed === null ? all : all.filter((l) => allowed.includes(l.id));
  if (locations.length === 0) return { locations, active: null };

  const jar = await cookies();
  const cookieId = jar.get(COOKIE_NAME)?.value;
  const fromCookie = cookieId ? locations.find((l) => l.id === cookieId) : undefined;

  // Default: prefer a clinic, else fall back to whatever is first.
  const fallback = locations.find((l) => l.type === 'clinic') ?? locations[0];

  return { locations, active: fromCookie ?? fallback };
}

/**
 * Writes the switcher's cookie. The caller (setActiveLocationAction) must
 * already have checked the id is one of the caller's locations.
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
