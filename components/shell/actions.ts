'use server';

import { revalidatePath } from 'next/cache';
import { signOut } from '@/auth';
import { loadLocationsForCaller, persistActiveLocation } from '@/lib/active-location';
import { requireAuthContext } from '@/lib/rbac';
import { log } from '@/lib/logger';

export async function signOutAction() {
  await signOut({ redirectTo: '/signin' });
}

export async function setActiveLocationAction(id: string) {
  // Only a location this caller may navigate to. The switcher never offers
  // another one, so anything else is a crafted call: it is refused here, server
  // side, rather than trusted to the read path that would ignore the cookie.
  const ctx = await requireAuthContext();
  const { locations } = await loadLocationsForCaller(ctx);
  if (!locations.some((l) => l.id === id)) {
    log.warn('active_location.refused', { userId: ctx.userId });
    return;
  }
  await persistActiveLocation(id);
  // Every module page depends on the active location; blast the cache for the
  // whole app segment so labels + data refresh.
  revalidatePath('/', 'layout');
}
