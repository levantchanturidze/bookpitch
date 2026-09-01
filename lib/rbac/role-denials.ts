// -----------------------------------------------------------------------------
// F16-012 — role-level denials that do not depend on the database bundle.
//
// Permissions live in the database (CLAUDE.md invariant 7), and this does not
// change that: nothing here *grants* anything, so adding a permission still
// needs no code change. It only removes.
//
// The reason it exists is deployment ordering. Migration 63 deletes
// client.read:contact from MARKETING, but a rollout is two steps and either can
// land first. If the new application starts against a database that still holds
// the old row — a perfectly ordinary ordering, and the state during any rollout
// window — the permission check would read that row and allow patient contact
// data through. The window is small; the data is patient contact details.
//
// So the denial is asserted in code as well as removed in data. The migration
// makes the state correct; this makes the ordering irrelevant.
//
// Same shape as RESTRICTED_DURING_IMPERSONATION: a deny list consulted above
// the granted set, never below it.
// -----------------------------------------------------------------------------

/**
 * Permission keys a role may never hold, whatever `role_permissions` says.
 *
 * Keyed by role key. Prefix match: an entry of `client.read` denies
 * `client.read:basic`, `client.read:contact` and `client.read:full`.
 */
export const ROLE_PERMISSION_DENIALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'MARKETING',
    new Set([
      // Identifiable patient data. Marketing gets aggregate reporting only;
      // a campaign needing contact data needs its own permission with a stated
      // purpose, consent handling, minimum-necessary fields and an audit trail.
      'client.read',
      'client.create',
      'client.update',
      'client.delete',
      'client.export',
      'clinical_note.read',
      'clinical_note.write',
    ]),
  ],
]);

/** True when `roleKey` is denied `permission` regardless of its granted set. */
export function isDeniedByRole(roleKey: string | null, permission: string): boolean {
  if (!roleKey) return false;
  const denied = ROLE_PERMISSION_DENIALS.get(roleKey);
  if (!denied) return false;
  // Exact match, or the scope-suffixed form of a denied base key.
  const base = permission.split(':')[0];
  return denied.has(permission) || denied.has(base);
}
