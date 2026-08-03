// -----------------------------------------------------------------------------
// RBAC seed — populates `roles`, `permissions`, `role_permissions` per spec
// §4, §5, §6. Reference data only; no tenant rows are created here.
//
// Idempotent: running this five times leaves the same state as running it
// once. Achieved via ON CONFLICT / find-then-upsert on every write.
//
// Callable from prisma/seed.ts (with the rest of the dev seed) or standalone:
//   npx tsx prisma/rbac-seed.ts
// -----------------------------------------------------------------------------

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// System roles (spec §4). `rank` is the numeric weight for the escalation
// guard (spec §9 rule 2) — but note §4.2's warning that ranks form a lattice,
// not a chain. Actual "who can manage whom" logic in Phase 3+ layers an
// explicit `can_manage_roles` relation on top of rank.
// -----------------------------------------------------------------------------
type Plane = 'platform' | 'organization' | 'consumer';

const SYSTEM_ROLES: ReadonlyArray<{
  key: string;
  display: string;
  plane: Plane;
  rank: number;
}> = [
  // Platform plane
  { key: 'SUPER_ADMIN',     display: 'Super Admin',     plane: 'platform',     rank: 1000 },
  { key: 'PLATFORM_ADMIN',  display: 'Platform Admin',  plane: 'platform',     rank: 900  },
  { key: 'BILLING_MANAGER', display: 'Billing Manager', plane: 'platform',     rank: 850  },
  { key: 'SUPPORT_AGENT',   display: 'Support Agent',   plane: 'platform',     rank: 800  },
  // Organization plane
  { key: 'ORG_OWNER',        display: 'Owner',           plane: 'organization', rank: 100 },
  { key: 'ORG_ADMIN',        display: 'Admin',           plane: 'organization', rank: 80  },
  { key: 'BRANCH_MANAGER',   display: 'Branch Manager',  plane: 'organization', rank: 60  },
  { key: 'SENIOR_PROVIDER',  display: 'Senior Provider', plane: 'organization', rank: 50  },
  { key: 'FRONT_DESK',       display: 'Front Desk',      plane: 'organization', rank: 40  },
  { key: 'PROVIDER',         display: 'Provider',        plane: 'organization', rank: 40  },
  { key: 'ACCOUNTANT',       display: 'Accountant',      plane: 'organization', rank: 30  },
  { key: 'MARKETING',        display: 'Marketing',       plane: 'organization', rank: 30  },
  // Consumer plane — marker only. CLIENT is not RBAC-managed; its access
  // is resolved by ownership (spec §4.3). Seeded so future code can
  // reference the row instead of a magic string.
  { key: 'CLIENT',           display: 'Client',          plane: 'consumer',     rank: 0   },
] as const;

// -----------------------------------------------------------------------------
// Permissions (spec §5). `resource.action:scope` grammar. Some spec keys use
// `:any` as a synonym for the strongest scope short of platform — we normalise
// that to `:org` so `can()` in Phase 3 only has to reason about four scopes
// (own | branch | org | platform) plus discount tiers (limited/unlimited)
// and client-detail tiers (basic/contact/full).
//
// Keys not literally in spec §5 but needed to make the §6 matrix expressible:
//   • service.manage / service.price.manage / resource.manage — spec §6.2
//     mentions services + prices + resources but §5 has no keys.
//   • staff.commission.read — separate from .manage so ACCOUNTANT can view
//     without editing (§6.2 👁️).
//   • org.billing.read — same reason for ACCOUNTANT.
//   • audit.read — org-level audit-log view (spec has platform.audit.read
//     only, but §6.2 puts OWNER=✅ ADMIN=👁️ on the org audit log).
//   • platform.billing.manage / .read, platform.org.delete,
//     platform.org.owner.change, platform.config.manage,
//     platform.analytics.read — implied by the §6.1 matrix rows.
//
// All decisions documented in docs/rbac-schema-notes.md.
// -----------------------------------------------------------------------------
const P: ReadonlyArray<{
  key: string;
  resource: string;
  action: string;
  scope: string | null;
  desc: string;
}> = [
  // BOOKINGS ---------------------------------------------------------------
  { key: 'booking.create',           resource: 'booking',  action: 'create',     scope: null,     desc: 'Create a booking' },
  { key: 'booking.read:own',         resource: 'booking',  action: 'read',       scope: 'own',    desc: 'Read own bookings only' },
  { key: 'booking.read:branch',      resource: 'booking',  action: 'read',       scope: 'branch', desc: 'Read bookings in assigned branches' },
  { key: 'booking.read:org',         resource: 'booking',  action: 'read',       scope: 'org',    desc: 'Read all bookings in the organization' },
  { key: 'booking.update:own',       resource: 'booking',  action: 'update',     scope: 'own',    desc: 'Update own bookings' },
  { key: 'booking.update:branch',    resource: 'booking',  action: 'update',     scope: 'branch', desc: 'Update bookings in assigned branches' },
  { key: 'booking.update:org',       resource: 'booking',  action: 'update',     scope: 'org',    desc: 'Update any booking in the org' },
  { key: 'booking.cancel:own',       resource: 'booking',  action: 'cancel',     scope: 'own',    desc: 'Cancel own bookings' },
  { key: 'booking.cancel:branch',    resource: 'booking',  action: 'cancel',     scope: 'branch', desc: 'Cancel bookings in assigned branches' },
  { key: 'booking.cancel:org',       resource: 'booking',  action: 'cancel',     scope: 'org',    desc: 'Cancel any booking in the org' },
  { key: 'booking.block_time:own',   resource: 'booking',  action: 'block_time', scope: 'own',    desc: 'Block time on own calendar' },
  { key: 'booking.block_time:branch',resource: 'booking',  action: 'block_time', scope: 'branch', desc: 'Block time in assigned branches' },
  { key: 'booking.block_time:org',   resource: 'booking',  action: 'block_time', scope: 'org',    desc: 'Block time anywhere in the org' },

  // CLIENTS ----------------------------------------------------------------
  { key: 'client.create',            resource: 'client',   action: 'create',     scope: null,     desc: 'Add a new client' },
  { key: 'client.read:basic',        resource: 'client',   action: 'read',       scope: 'basic',  desc: 'Name + appointment time only' },
  { key: 'client.read:contact',      resource: 'client',   action: 'read',       scope: 'contact',desc: '+ phone + email' },
  { key: 'client.read:full',         resource: 'client',   action: 'read',       scope: 'full',   desc: '+ full history + files' },
  { key: 'client.merge',             resource: 'client',   action: 'merge',      scope: null,     desc: 'Merge duplicate client records' },
  { key: 'client.export',            resource: 'client',   action: 'export',     scope: null,     desc: 'Bulk-export client data' },

  // CLINICAL NOTES ---------------------------------------------------------
  { key: 'clinical_note.create',              resource: 'clinical_note', action: 'create',           scope: null,  desc: 'Create a clinical note' },
  { key: 'clinical_note.read:own',            resource: 'clinical_note', action: 'read',             scope: 'own', desc: 'Read own clinical notes' },
  { key: 'clinical_note.read:any',            resource: 'clinical_note', action: 'read',             scope: 'any', desc: 'Read any clinician\'s notes (⚙️ per-org toggle)' },
  { key: 'clinical_note.attachment.manage',   resource: 'clinical_note', action: 'attachment.manage',scope: null,  desc: 'Attach/remove files on clinical notes' },

  // PAYMENTS ---------------------------------------------------------------
  { key: 'payment.charge',             resource: 'payment', action: 'charge',        scope: null,        desc: 'Accept a payment' },
  { key: 'payment.refund',             resource: 'payment', action: 'refund',        scope: null,        desc: 'Refund a payment' },
  { key: 'payment.discount:limited',   resource: 'payment', action: 'discount',      scope: 'limited',   desc: 'Apply a bounded discount (per-org cap)' },
  { key: 'payment.discount:unlimited', resource: 'payment', action: 'discount',      scope: 'unlimited', desc: 'Apply any discount' },
  { key: 'payment.shift.close',        resource: 'payment', action: 'shift.close',   scope: null,        desc: 'Close a cash-register shift' },

  // STAFF ------------------------------------------------------------------
  { key: 'staff.invite',              resource: 'staff', action: 'invite',            scope: null, desc: 'Send a staff invitation' },
  { key: 'staff.update',              resource: 'staff', action: 'update',            scope: null, desc: 'Edit a staff profile' },
  { key: 'staff.deactivate',          resource: 'staff', action: 'deactivate',        scope: null, desc: 'Deactivate a staff account' },
  { key: 'staff.role.assign',         resource: 'staff', action: 'role.assign',       scope: null, desc: 'Assign or change a staff role' },
  { key: 'staff.schedule.manage:own', resource: 'staff', action: 'schedule.manage',   scope: 'own',   desc: 'Edit own schedule' },
  { key: 'staff.schedule.manage:branch', resource: 'staff', action: 'schedule.manage',scope: 'branch',desc: 'Edit schedules in assigned branches' },
  { key: 'staff.schedule.manage:org', resource: 'staff', action: 'schedule.manage',   scope: 'org',   desc: 'Edit any staff schedule' },
  { key: 'staff.commission.manage',   resource: 'staff', action: 'commission.manage', scope: null, desc: 'Set commission rates' },
  { key: 'staff.commission.read',     resource: 'staff', action: 'commission.read',   scope: null, desc: 'View commission rates (read-only)' },

  // SERVICES / RESOURCES ---------------------------------------------------
  { key: 'service.manage',          resource: 'service',  action: 'manage', scope: null, desc: 'CRUD services + categories' },
  { key: 'service.price.manage',    resource: 'service',  action: 'price.manage', scope: null, desc: 'Change service prices' },
  { key: 'resource.manage:org',     resource: 'resource', action: 'manage', scope: 'org',    desc: 'Manage rooms/equipment (org-wide)' },
  { key: 'resource.manage:branch',  resource: 'resource', action: 'manage', scope: 'branch', desc: 'Manage rooms/equipment in assigned branches' },

  // REPORTS ----------------------------------------------------------------
  { key: 'report.own',              resource: 'report', action: 'read',   scope: 'own',    desc: 'Personal performance' },
  { key: 'report.branch',           resource: 'report', action: 'read',   scope: 'branch', desc: 'Branch-level reports' },
  { key: 'report.financial:org',    resource: 'report', action: 'financial', scope: 'org', desc: 'Org-wide financial reports' },
  { key: 'report.payroll',          resource: 'report', action: 'payroll',scope: null,     desc: 'Payroll report' },
  { key: 'report.export',           resource: 'report', action: 'export', scope: null,     desc: 'Export any report' },

  // ORGANIZATION -----------------------------------------------------------
  { key: 'org.settings.update:org',    resource: 'org', action: 'settings.update',   scope: 'org',    desc: 'Edit org profile + hours' },
  { key: 'org.settings.update:branch', resource: 'org', action: 'settings.update',   scope: 'branch', desc: 'Edit branch profile + hours' },
  { key: 'org.branch.manage',          resource: 'org', action: 'branch.manage',     scope: null,     desc: 'CRUD branches' },
  { key: 'org.billing.manage',         resource: 'org', action: 'billing.manage',    scope: null,     desc: 'Subscription + payment methods' },
  { key: 'org.billing.read',           resource: 'org', action: 'billing.read',      scope: null,     desc: 'View invoices + subscription (read-only)' },
  { key: 'org.integration.manage',     resource: 'org', action: 'integration.manage',scope: null,     desc: 'Manage API keys + integrations' },
  { key: 'org.ownership.transfer',     resource: 'org', action: 'ownership.transfer',scope: null,     desc: 'Transfer org ownership' },
  { key: 'org.delete',                 resource: 'org', action: 'delete',            scope: null,     desc: 'Soft-delete the organization' },

  // AUDIT (org-scope; platform.audit.read below) --------------------------
  { key: 'audit.read',              resource: 'audit', action: 'read',    scope: 'org',    desc: 'Read the org audit log' },

  // PLATFORM ---------------------------------------------------------------
  { key: 'platform.org.create',           resource: 'platform', action: 'org.create',        scope: 'platform', desc: 'Create an organization' },
  { key: 'platform.org.suspend',          resource: 'platform', action: 'org.suspend',       scope: 'platform', desc: 'Suspend/activate an organization' },
  { key: 'platform.org.delete',           resource: 'platform', action: 'org.delete',        scope: 'platform', desc: 'Permanently delete an organization' },
  { key: 'platform.org.owner.change',     resource: 'platform', action: 'org.owner.change',  scope: 'platform', desc: 'Invite or replace the org owner' },
  { key: 'platform.user.password_reset',  resource: 'platform', action: 'user.password_reset',scope: 'platform',desc: 'Send a password-reset link (never set directly, §9 rule 4)' },
  { key: 'platform.impersonate',          resource: 'platform', action: 'impersonate',       scope: 'platform', desc: 'Start an impersonation session (§7.1)' },
  { key: 'platform.role.assign',          resource: 'platform', action: 'role.assign',       scope: 'platform', desc: 'Assign platform roles' },
  { key: 'platform.audit.read',           resource: 'platform', action: 'audit.read',        scope: 'platform', desc: 'Read the platform audit log' },
  { key: 'platform.billing.manage',       resource: 'platform', action: 'billing.manage',    scope: 'platform', desc: 'Manage subscriptions + invoices platform-wide' },
  { key: 'platform.billing.read',         resource: 'platform', action: 'billing.read',      scope: 'platform', desc: 'View subscriptions + invoices (read-only)' },
  { key: 'platform.config.manage',        resource: 'platform', action: 'config.manage',     scope: 'platform', desc: 'Feature flags + global config' },
  { key: 'platform.analytics.read',       resource: 'platform', action: 'analytics.read',    scope: 'platform', desc: 'Aggregate analytics (no PII)' },
] as const;

// -----------------------------------------------------------------------------
// Role → permission mapping (spec §6.1 platform + §6.2 organization).
//
// ⚙️ cells (owner-configurable): SEED AT THE MOST RESTRICTIVE READING.
// A trailing `// ⚙️` comment marks the omissions so Phase 6 can find them.
// TODO(Phase 6): expose per-org toggles matching these ⚙️ decisions.
//
// Grant model: shortest-scope-that-works. If a role has :org scope, it
// covers :branch and :own for the same permission (spec §10). Rows are
// not duplicated across scopes.
// -----------------------------------------------------------------------------

// Convenience: build a wildcard bundle for SUPER_ADMIN (every permission key).
const ALL_PERMISSIONS = P.map(p => p.key);

const ROLE_PERMISSIONS: Record<string, ReadonlyArray<string>> = {
  // PLATFORM PLANE ---------------------------------------------------------
  SUPER_ADMIN: ALL_PERMISSIONS,  // spec §4.1: no ceiling

  PLATFORM_ADMIN: [
    'platform.org.create',
    'platform.org.suspend',
    'platform.org.owner.change',
    'platform.user.password_reset',
    'platform.impersonate',           // gated by org.allow_support_impersonation
    'platform.audit.read',
    'platform.billing.manage',
    'platform.analytics.read',
    // No: platform.org.delete (SUPER_ADMIN only)
    // No: platform.role.assign (SUPER_ADMIN only)
    // No: platform.config.manage (SUPER_ADMIN only)
  ],

  SUPPORT_AGENT: [
    // Read-only diagnostics. Cannot start impersonation (spec §6.1 —
    // "may request, not start"). PII is masked at the query layer in
    // Phase 5.
    'platform.audit.read',
    'platform.billing.read',
    'platform.analytics.read',
  ],

  BILLING_MANAGER: [
    'platform.billing.manage',
    'platform.billing.read',
    'platform.analytics.read',
  ],

  // ORG PLANE --------------------------------------------------------------
  ORG_OWNER: [
    // Bookings
    'booking.create', 'booking.read:org', 'booking.update:org',
    'booking.cancel:org', 'booking.block_time:org',
    // Clients
    'client.create', 'client.read:contact', 'client.read:full',
    'client.merge', 'client.export',
    // Clinical (own only; ⚙️ toggle guards create + read:any)
    'clinical_note.read:own',
    // Payments
    'payment.charge', 'payment.refund',
    'payment.discount:limited', 'payment.discount:unlimited',
    'payment.shift.close',
    // Staff
    'staff.invite', 'staff.update', 'staff.deactivate', 'staff.role.assign',
    'staff.schedule.manage:org', 'staff.commission.manage', 'staff.commission.read',
    // Services / resources
    'service.manage', 'service.price.manage', 'resource.manage:org',
    // Reports
    'report.own', 'report.branch', 'report.financial:org', 'report.payroll', 'report.export',
    // Org
    'org.settings.update:org', 'org.branch.manage',
    'org.billing.manage', 'org.billing.read',
    'org.integration.manage', 'org.ownership.transfer', 'org.delete',
    // Audit
    'audit.read',
  ],

  ORG_ADMIN: [
    // Same operational surface as OWNER minus billing / ownership / delete
    // and minus a handful of ⚙️ items that owners must opt in to.
    'booking.create', 'booking.read:org', 'booking.update:org',
    'booking.cancel:org', 'booking.block_time:org',
    'client.create', 'client.read:contact', 'client.read:full',
    'client.merge', 'client.export',
    'clinical_note.read:own',
    'payment.charge', 'payment.refund',
    'payment.discount:limited', 'payment.discount:unlimited',
    'payment.shift.close',
    'staff.invite', 'staff.update', 'staff.deactivate',
    // ⚙️ staff.role.assign — owner-only by default
    'staff.schedule.manage:org', 'staff.commission.read',
    // ⚙️ staff.commission.manage — owner-only by default
    'service.manage', 'service.price.manage', 'resource.manage:org',
    'report.own', 'report.branch',
    // ⚙️ report.financial:org, report.payroll, report.export — owner-only by default
    'org.settings.update:org', 'org.branch.manage',
    // ⚙️ org.integration.manage — owner-only by default
    'audit.read',
    // No: org.billing.*, org.ownership.transfer, org.delete
  ],

  BRANCH_MANAGER: [
    'booking.create', 'booking.read:branch', 'booking.update:branch',
    'booking.cancel:branch', 'booking.block_time:branch',
    'client.create', 'client.read:contact', 'client.read:full',
    'payment.charge',
    // ⚙️ payment.refund — configurable, off by default
    'payment.discount:limited', 'payment.shift.close',
    'staff.invite', 'staff.update', 'staff.deactivate',
    'staff.schedule.manage:branch',
    // ⚙️ service.manage — configurable, off by default
    'resource.manage:branch',
    'report.own', 'report.branch',
    'org.settings.update:branch',
  ],

  FRONT_DESK: [
    'booking.create', 'booking.read:branch', 'booking.update:branch',
    'booking.cancel:branch', 'booking.block_time:branch',
    'client.create', 'client.read:contact',
    // ⚙️ client.read:full — off by default; owner enables per-org
    'payment.charge',
    // ⚙️ payment.discount:limited — off by default
    'payment.shift.close',
    // ⚙️ staff.schedule.manage — off by default (unlike BRANCH_MANAGER)
    'report.own',
  ],

  PROVIDER: [
    // Own scope pervades this role.
    'booking.create',
    'booking.read:own', 'booking.update:own',
    'booking.cancel:own', 'booking.block_time:own',
    'client.create', 'client.read:contact',
    // ⚙️ client.read:full — off by default
    'clinical_note.create',
    'clinical_note.read:own',
    // ⚙️ clinical_note.read:any — off by default (privacy default)
    'clinical_note.attachment.manage',
    // ⚙️ payment.charge — off by default (rare that providers handle cash)
    'staff.schedule.manage:own',
    'staff.commission.read',   // own row only; enforced at query layer
    'report.own',
  ],

  SENIOR_PROVIDER: [
    // Provider superset: also sees the team's calendar and (optionally) notes.
    'booking.create',
    'booking.read:branch', 'booking.update:own',
    'booking.cancel:own', 'booking.block_time:own',
    'client.create', 'client.read:contact',
    'clinical_note.create', 'clinical_note.read:own',
    // ⚙️ clinical_note.read:any — off by default (senior can be granted)
    'clinical_note.attachment.manage',
    'staff.schedule.manage:branch',
    'staff.commission.read',
    'report.own', 'report.branch',
  ],

  ACCOUNTANT: [
    // Read-only financial. NO calendar, NO clinical, NO PII beyond what
    // shows on an invoice.
    'report.branch',           // view only — enforced by absence of write perms
    'report.financial:org',
    'report.payroll',
    'report.export',
    'org.billing.read',
    'staff.commission.read',
  ],

  MARKETING: [
    // Not fully spec'd — spec §4.2 leaves this as a placeholder ("campaigns,
    // promo codes, segments"). Minimum viable seed for now:
    'client.read:contact',   // to see segments
    'report.own', 'report.branch',
    // No financial, no clinical.
  ],

  // CONSUMER PLANE — CLIENT has no RBAC permissions. Access resolved by
  // ownership (spec §4.3, §9 rule 8).
  CLIENT: [],
};

// -----------------------------------------------------------------------------
// Idempotent writers
// -----------------------------------------------------------------------------
async function upsertRoles() {
  for (const r of SYSTEM_ROLES) {
    // Partial unique on (key) WHERE org_id IS NULL. Prisma cannot target it,
    // so use a raw statement.
    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO roles (key, display_name, plane, rank, organization_id, is_system)
      VALUES (${r.key}, ${r.display}, ${r.plane}, ${r.rank}, NULL, true)
      ON CONFLICT (key) WHERE organization_id IS NULL
        DO UPDATE SET display_name = EXCLUDED.display_name,
                      plane        = EXCLUDED.plane,
                      rank         = EXCLUDED.rank,
                      is_system    = true
    `;
  }
}

async function upsertPermissions() {
  for (const p of P) {
    await unsafePrismaAdmin.permission.upsert({
      where: { key: p.key },
      create: {
        key: p.key,
        resource: p.resource,
        action: p.action,
        scope: p.scope,
        description: p.desc,
      },
      update: {
        resource: p.resource,
        action: p.action,
        scope: p.scope,
        description: p.desc,
      },
    });
  }
}

async function upsertRolePermissions() {
  const roles = await unsafePrismaAdmin.role.findMany({
    where: { organizationId: null, isSystem: true },
    select: { id: true, key: true },
  });
  const roleIdByKey = new Map(roles.map(r => [r.key, r.id]));

  for (const [roleKey, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByKey.get(roleKey);
    if (!roleId) {
      throw new Error(`RBAC seed: role ${roleKey} not found (upsertRoles must run first)`);
    }
    // Two-way sync: add missing, remove extras. This is what makes the seed
    // safe to re-run after a spec change — the DB converges to the file.
    const existing = await unsafePrismaAdmin.rolePermission.findMany({
      where: { roleId },
      select: { permissionKey: true },
    });
    const existingSet = new Set(existing.map(r => r.permissionKey));
    const wantSet = new Set(permKeys);

    const toAdd = permKeys.filter(k => !existingSet.has(k));
    const toRemove = existing.filter(r => !wantSet.has(r.permissionKey))
                             .map(r => r.permissionKey);

    if (toAdd.length > 0) {
      await unsafePrismaAdmin.rolePermission.createMany({
        data: toAdd.map(permissionKey => ({ roleId, permissionKey })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await unsafePrismaAdmin.rolePermission.deleteMany({
        where: { roleId, permissionKey: { in: toRemove } },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Role management lattice (Phase 3) — spec §4.2.
//
// Ranks aren't a chain — FRONT_DESK and PROVIDER both sit at rank 40 but
// operate in different domains. lib/rbac/rank.ts::canManageRoleAssignment
// requires BOTH numeric rank AND an edge in this lattice.
//
// Only org-plane edges seeded here for MVP. Platform-plane management
// (SUPER_ADMIN → PLATFORM_ADMIN / SUPPORT_AGENT / BILLING_MANAGER) is
// also included because the same helper covers it.
// -----------------------------------------------------------------------------
const CAN_MANAGE: Record<string, ReadonlyArray<string>> = {
  // Platform plane
  SUPER_ADMIN: ['PLATFORM_ADMIN', 'BILLING_MANAGER', 'SUPPORT_AGENT'],
  PLATFORM_ADMIN: ['SUPPORT_AGENT'],
  // BILLING_MANAGER, SUPPORT_AGENT — no one below them; empty.

  // Org plane
  ORG_OWNER: [
    'ORG_ADMIN', 'BRANCH_MANAGER',
    'SENIOR_PROVIDER', 'FRONT_DESK', 'PROVIDER',
    'ACCOUNTANT', 'MARKETING',
  ],
  ORG_ADMIN: [
    'BRANCH_MANAGER',
    'SENIOR_PROVIDER', 'FRONT_DESK', 'PROVIDER',
    'ACCOUNTANT', 'MARKETING',
  ],
  BRANCH_MANAGER: ['FRONT_DESK', 'PROVIDER'],
  SENIOR_PROVIDER: ['PROVIDER'],
  // FRONT_DESK, PROVIDER, ACCOUNTANT, MARKETING — peer or leaf; empty.

  // Consumer plane
  // CLIENT: not RBAC-managed (spec §4.3).
};

async function upsertRoleCanManage() {
  const roles = await unsafePrismaAdmin.role.findMany({
    where: { organizationId: null, isSystem: true },
    select: { id: true, key: true },
  });
  const idByKey = new Map(roles.map(r => [r.key, r.id]));

  // Compute desired edges as a Set for two-way sync.
  const wantEdges = new Set<string>();
  for (const [parentKey, childKeys] of Object.entries(CAN_MANAGE)) {
    const parentId = idByKey.get(parentKey);
    if (!parentId) throw new Error(`RBAC seed: role ${parentKey} not found`);
    for (const childKey of childKeys) {
      const childId = idByKey.get(childKey);
      if (!childId) throw new Error(`RBAC seed: role ${childKey} not found`);
      wantEdges.add(`${parentId} ${childId}`);
    }
  }

  const existing = await unsafePrismaAdmin.roleCanManage.findMany({
    select: { parentRoleId: true, childRoleId: true },
  });
  const existingSet = new Set(existing.map(e => `${e.parentRoleId} ${e.childRoleId}`));

  const toAdd = [...wantEdges].filter(k => !existingSet.has(k));
  const toRemove = existing.filter(e => !wantEdges.has(`${e.parentRoleId} ${e.childRoleId}`));

  if (toAdd.length > 0) {
    await unsafePrismaAdmin.roleCanManage.createMany({
      data: toAdd.map(k => {
        const [parentRoleId, childRoleId] = k.split(' ');
        return { parentRoleId, childRoleId };
      }),
      skipDuplicates: true,
    });
  }
  for (const e of toRemove) {
    await unsafePrismaAdmin.roleCanManage.delete({
      where: { parentRoleId_childRoleId: { parentRoleId: e.parentRoleId, childRoleId: e.childRoleId } },
    });
  }
}

// -----------------------------------------------------------------------------
// Main entry.
// -----------------------------------------------------------------------------
export async function seedRbac(): Promise<void> {
  await upsertRoles();
  await upsertPermissions();
  await upsertRolePermissions();
  await upsertRoleCanManage();
}

// If invoked directly (npx tsx prisma/rbac-seed.ts), run + disconnect.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedRbac()
    .then(async () => {
      const [roleCount, permCount, rpCount, edgeCount] = await Promise.all([
        unsafePrismaAdmin.role.count({ where: { isSystem: true } }),
        unsafePrismaAdmin.permission.count(),
        unsafePrismaAdmin.rolePermission.count(),
        unsafePrismaAdmin.roleCanManage.count(),
      ]);
      console.log('✔ RBAC seed complete:', { roleCount, permCount, rpCount, edgeCount });
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await unsafePrismaAdmin.$disconnect();
    });
}
