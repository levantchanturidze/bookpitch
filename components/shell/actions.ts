'use server';

import { revalidatePath } from 'next/cache';
import { signOut } from '@/auth';
import { persistActiveLocation } from '@/lib/active-location';

export async function signOutAction() {
  await signOut({ redirectTo: '/signin' });
}

export async function setActiveLocationAction(id: string) {
  await persistActiveLocation(id);
  // Every module page depends on the active location; blast the cache for the
  // whole app segment so labels + data refresh.
  revalidatePath('/', 'layout');
}
