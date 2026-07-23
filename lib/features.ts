import { withoutRls } from '@/lib/db';

// -----------------------------------------------------------------------------
// Feature flags. Names + defaults are declared here so unknown flags in the
// DB row are ignored and a rollout is *always* a code change reviewers can
// see, not a silent JSONB edit.
// -----------------------------------------------------------------------------

export const FLAGS = {
  assistant_streaming: false,
  patient_booking_widget: false,
  insurance_codes: false,
} as const;

export type FlagName = keyof typeof FLAGS;

const TTL_MS = 30_000;
const cache = new Map<string, { flags: Record<string, unknown>; at: number }>();

async function loadFlags(orgId: string): Promise<Record<string, unknown>> {
  const hit = cache.get(orgId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.flags;
  const row = await withoutRls((tx) =>
    tx.organization.findUnique({
      where: { id: orgId },
      select: { features: true },
    }),
  );
  const flags = (row?.features as Record<string, unknown> | null) ?? {};
  cache.set(orgId, { flags, at: now });
  return flags;
}

export async function isFeatureEnabled(orgId: string, name: FlagName): Promise<boolean> {
  const flags = await loadFlags(orgId);
  const raw = flags[name];
  if (typeof raw === 'boolean') return raw;
  // Unknown / non-boolean → fall back to the compile-time default.
  return FLAGS[name];
}

export async function setFeature(orgId: string, name: FlagName, on: boolean): Promise<void> {
  const current = await loadFlags(orgId);
  const next: Record<string, unknown> = { ...current, [name]: on };
  await withoutRls((tx) =>
    tx.organization.update({
      where: { id: orgId },
      // Prisma's Json input type is stricter than Record<string, unknown>;
      // the values here are all booleans so the cast is safe.
      data: { features: next as import('@prisma/client').Prisma.InputJsonValue },
    }),
  );
  cache.set(orgId, { flags: next, at: Date.now() });
}

// Test hook — flush the in-process cache. Not exported through index.
export function _clearFeatureCache(): void {
  cache.clear();
}
