// -----------------------------------------------------------------------------
// Allowlisted purpose values for platform reauthentication grants.
//
// Every reauth grant is bound to exactly one purpose. A grant for
// 'platform.mfa.enroll' cannot authorize 'platform.org.suspend'. Adding a
// new purpose requires changing this file and shipping — intentionally not a
// database-driven enum so the set is small, auditable, and reviewed at
// code-review time rather than through an admin UI.
// -----------------------------------------------------------------------------

export const REAUTH_PURPOSES = [
  'platform.mfa.enroll',
  'platform.mfa.confirm',
  'platform.org.suspend',
  'platform.org.delete',
  // Configuring security-sensitive org settings (toggles, impersonation policy).
  'platform.org.configure',
  'platform.break_glass.start',
  'platform.mfa.recovery_codes',
] as const;

export type ReauthPurpose = (typeof REAUTH_PURPOSES)[number];

export function isReauthPurpose(value: unknown): value is ReauthPurpose {
  return typeof value === 'string' && (REAUTH_PURPOSES as readonly string[]).includes(value);
}
