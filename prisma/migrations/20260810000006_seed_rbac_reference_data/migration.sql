-- =============================================================================
-- Seed RBAC reference data (roles, permissions, role_permissions) in production.
--
-- Production never runs `prisma db seed` — reference data must travel through
-- a migration. This migration is the authoritative snapshot of rbac-seed.ts
-- at the time of writing. It is idempotent via ON CONFLICT … DO NOTHING on
-- every insert, so re-running it in dev/CI (which already has seed data)
-- is safe.
--
-- After seeding roles, the SUPER_ADMIN assignment for levaaani@gmail.com is
-- also corrected here (the prior guard migrations were no-ops because the
-- SUPER_ADMIN role didn't exist yet in prod).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. System roles
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO roles (key, display_name, plane, rank, organization_id, is_system)
VALUES
  ('SUPER_ADMIN',      'Super Admin',     'platform',     1000, NULL, true),
  ('PLATFORM_ADMIN',   'Platform Admin',  'platform',      900, NULL, true),
  ('BILLING_MANAGER',  'Billing Manager', 'platform',      850, NULL, true),
  ('SUPPORT_AGENT',    'Support Agent',   'platform',      800, NULL, true),
  ('ORG_OWNER',        'Owner',           'organization',  100, NULL, true),
  ('ORG_ADMIN',        'Admin',           'organization',   80, NULL, true),
  ('BRANCH_MANAGER',   'Branch Manager',  'organization',   60, NULL, true),
  ('SENIOR_PROVIDER',  'Senior Provider', 'organization',   50, NULL, true),
  ('FRONT_DESK',       'Front Desk',      'organization',   40, NULL, true),
  ('PROVIDER',         'Provider',        'organization',   40, NULL, true),
  ('ACCOUNTANT',       'Accountant',      'organization',   30, NULL, true),
  ('MARKETING',        'Marketing',       'organization',   30, NULL, true),
  ('CLIENT',           'Client',          'consumer',        0, NULL, true)
ON CONFLICT (key) WHERE organization_id IS NULL DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Permissions (key is primary key — ON CONFLICT on PK)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO permissions (key, resource, action, scope, description)
VALUES
  -- BOOKINGS
  ('booking.create',          'booking', 'create',     NULL,       'Create a booking'),
  ('booking.read:own',        'booking', 'read',       'own',      'Read own bookings only'),
  ('booking.read:branch',     'booking', 'read',       'branch',   'Read bookings in assigned branches'),
  ('booking.read:org',        'booking', 'read',       'org',      'Read all bookings in the organization'),
  ('booking.update:own',      'booking', 'update',     'own',      'Update own bookings'),
  ('booking.update:branch',   'booking', 'update',     'branch',   'Update bookings in assigned branches'),
  ('booking.update:org',      'booking', 'update',     'org',      'Update any booking in the org'),
  ('booking.cancel:own',      'booking', 'cancel',     'own',      'Cancel own bookings [NOT YET IMPLEMENTED: booking_cancel_distinct]'),
  ('booking.cancel:branch',   'booking', 'cancel',     'branch',   'Cancel bookings in assigned branches [NOT YET IMPLEMENTED: booking_cancel_distinct]'),
  ('booking.cancel:org',      'booking', 'cancel',     'org',      'Cancel any booking in the org [NOT YET IMPLEMENTED: booking_cancel_distinct]'),
  ('booking.block_time:own',  'booking', 'block_time', 'own',      'Block time on own calendar [NOT YET IMPLEMENTED: booking_block_time]'),
  ('booking.block_time:branch','booking','block_time', 'branch',   'Block time in assigned branches [NOT YET IMPLEMENTED: booking_block_time]'),
  ('booking.block_time:org',  'booking', 'block_time', 'org',      'Block time anywhere in the org [NOT YET IMPLEMENTED: booking_block_time]'),
  -- CLIENTS
  ('client.create',           'client',  'create',     NULL,       'Add a new client'),
  ('client.read:basic',       'client',  'read',       'basic',    'Name + appointment time only'),
  ('client.read:contact',     'client',  'read',       'contact',  '+ phone + email'),
  ('client.read:full',        'client',  'read',       'full',     '+ full history + files'),
  ('client.merge',            'client',  'merge',      NULL,       'Merge duplicate client records'),
  ('client.export',           'client',  'export',     NULL,       'Bulk-export client data'),
  -- CLINICAL NOTES
  ('clinical_note.create',            'clinical_note', 'create',            NULL,   'Create a clinical note'),
  ('clinical_note.read:own',          'clinical_note', 'read',              'own',  'Read own clinical notes'),
  ('clinical_note.read:any',          'clinical_note', 'read',              'any',  'Read any clinician''s notes (per-org toggle)'),
  ('clinical_note.attachment.manage', 'clinical_note', 'attachment.manage', NULL,   'Attach/remove files on clinical notes'),
  -- PAYMENTS
  ('payment.charge',             'payment', 'charge',       NULL,        'Accept a payment'),
  ('payment.refund',             'payment', 'refund',       NULL,        'Refund a payment [NOT YET IMPLEMENTED: payment_refund]'),
  ('payment.discount:limited',   'payment', 'discount',     'limited',   'Apply a bounded discount [NOT YET IMPLEMENTED: payment_discount]'),
  ('payment.discount:unlimited', 'payment', 'discount',     'unlimited', 'Apply any discount [NOT YET IMPLEMENTED: payment_discount]'),
  ('payment.shift.close',        'payment', 'shift.close',  NULL,        'Close a cash-register shift [NOT YET IMPLEMENTED: payment_shift_close]'),
  -- STAFF
  ('staff.invite',                'staff', 'invite',           NULL,     'Send a staff invitation'),
  ('staff.update',                'staff', 'update',           NULL,     'Edit a staff profile'),
  ('staff.deactivate',            'staff', 'deactivate',       NULL,     'Deactivate a staff account'),
  ('staff.role.assign',           'staff', 'role.assign',      NULL,     'Assign or change a staff role'),
  ('staff.schedule.manage:own',   'staff', 'schedule.manage',  'own',    'Edit own schedule'),
  ('staff.schedule.manage:branch','staff', 'schedule.manage',  'branch', 'Edit schedules in assigned branches'),
  ('staff.schedule.manage:org',   'staff', 'schedule.manage',  'org',    'Edit any staff schedule'),
  ('staff.commission.manage',     'staff', 'commission.manage',NULL,     'Set commission rates [NOT YET IMPLEMENTED: staff_commission]'),
  ('staff.commission.read',       'staff', 'commission.read',  NULL,     'View commission rates [NOT YET IMPLEMENTED: staff_commission]'),
  -- SERVICES / RESOURCES
  ('service.manage',        'service',  'manage',  NULL,     'CRUD services + categories'),
  ('service.price.manage',  'service',  'price.manage', NULL,'Change service prices [NOT YET IMPLEMENTED: dead_alias]'),
  ('resource.manage:org',   'resource', 'manage',  'org',    'Manage rooms/equipment (org-wide) [NOT YET IMPLEMENTED: resources_rooms]'),
  ('resource.manage:branch','resource', 'manage',  'branch', 'Manage rooms/equipment in assigned branches [NOT YET IMPLEMENTED: resources_rooms]'),
  -- REPORTS
  ('report.own',          'report', 'read',      'own',    'Personal performance [NOT YET IMPLEMENTED: report_own_and_payroll]'),
  ('report.branch',       'report', 'read',      'branch', 'Branch-level reports'),
  ('report.financial:org','report', 'financial', 'org',    'Org-wide financial reports'),
  ('report.payroll',      'report', 'payroll',   NULL,     'Payroll report [NOT YET IMPLEMENTED: report_own_and_payroll]'),
  ('report.export',       'report', 'export',    NULL,     'Export any report'),
  -- ORGANIZATION
  ('org.settings.update:org',    'org', 'settings.update', 'org',    'Edit org profile + hours'),
  ('org.settings.update:branch', 'org', 'settings.update', 'branch', 'Edit branch profile + hours'),
  ('org.branch.manage',          'org', 'branch.manage',   NULL,     'CRUD branches'),
  ('org.billing.manage',         'org', 'billing.manage',  NULL,     'Subscription + payment methods'),
  ('org.billing.read',           'org', 'billing.read',    NULL,     'View invoices + subscription (read-only)'),
  ('org.integration.manage',     'org', 'integration.manage',NULL,  'Manage API keys + integrations [NOT YET IMPLEMENTED: integrations]'),
  ('org.ownership.transfer',     'org', 'ownership.transfer',NULL,  'Transfer org ownership'),
  ('org.delete',                 'org', 'delete',          NULL,     'Soft-delete the organization'),
  -- AUDIT
  ('audit.read', 'audit', 'read', 'org', 'Read the org audit log'),
  -- PLATFORM
  ('platform.org.create',          'platform', 'org.create',          'platform', 'Create an organization'),
  ('platform.org.suspend',         'platform', 'org.suspend',         'platform', 'Suspend/activate an organization'),
  ('platform.org.delete',          'platform', 'org.delete',          'platform', 'Permanently delete an organization'),
  ('platform.org.owner.change',    'platform', 'org.owner.change',    'platform', 'Invite or replace the org owner'),
  ('platform.user.password_reset', 'platform', 'user.password_reset', 'platform', 'Send a password-reset link'),
  ('platform.impersonate',         'platform', 'impersonate',         'platform', 'Start an impersonation session'),
  ('platform.role.assign',         'platform', 'role.assign',         'platform', 'Assign platform roles'),
  ('platform.audit.read',          'platform', 'audit.read',          'platform', 'Read the platform audit log'),
  ('platform.billing.manage',      'platform', 'billing.manage',      'platform', 'Manage subscriptions + invoices platform-wide [NOT YET IMPLEMENTED: platform_billing]'),
  ('platform.billing.read',        'platform', 'billing.read',        'platform', 'View subscriptions + invoices (read-only) [NOT YET IMPLEMENTED: platform_billing]'),
  ('platform.config.manage',       'platform', 'config.manage',       'platform', 'Feature flags + global config'),
  ('platform.analytics.read',      'platform', 'analytics.read',      'platform', 'Aggregate analytics (no PII)')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Role → permission mappings
-- ─────────────────────────────────────────────────────────────────────────────

-- SUPER_ADMIN: all permissions (spec §4.1 — no ceiling)
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'SUPER_ADMIN' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- PLATFORM_ADMIN
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('platform.org.create'),
  ('platform.org.suspend'),
  ('platform.org.owner.change'),
  ('platform.user.password_reset'),
  ('platform.impersonate'),
  ('platform.audit.read'),
  ('platform.billing.manage'),
  ('platform.analytics.read')
) AS t(perm)
WHERE r.key = 'PLATFORM_ADMIN' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- SUPPORT_AGENT
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('platform.audit.read'),
  ('platform.billing.read'),
  ('platform.analytics.read')
) AS t(perm)
WHERE r.key = 'SUPPORT_AGENT' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- BILLING_MANAGER
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('platform.billing.manage'),
  ('platform.billing.read'),
  ('platform.analytics.read')
) AS t(perm)
WHERE r.key = 'BILLING_MANAGER' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- ORG_OWNER
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('booking.create'),
  ('booking.read:org'),
  ('booking.update:org'),
  ('booking.cancel:org'),
  ('booking.block_time:org'),
  ('client.create'),
  ('client.read:contact'),
  ('client.read:full'),
  ('client.merge'),
  ('client.export'),
  ('clinical_note.read:own'),
  ('payment.charge'),
  ('payment.refund'),
  ('payment.discount:limited'),
  ('payment.discount:unlimited'),
  ('payment.shift.close'),
  ('staff.invite'),
  ('staff.update'),
  ('staff.deactivate'),
  ('staff.role.assign'),
  ('staff.schedule.manage:org'),
  ('staff.commission.manage'),
  ('staff.commission.read'),
  ('service.manage'),
  ('service.price.manage'),
  ('resource.manage:org'),
  ('report.own'),
  ('report.branch'),
  ('report.financial:org'),
  ('report.payroll'),
  ('report.export'),
  ('org.settings.update:org'),
  ('org.branch.manage'),
  ('org.billing.manage'),
  ('org.billing.read'),
  ('org.integration.manage'),
  ('org.ownership.transfer'),
  ('org.delete'),
  ('audit.read')
) AS t(perm)
WHERE r.key = 'ORG_OWNER' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- ORG_ADMIN
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('booking.create'),
  ('booking.read:org'),
  ('booking.update:org'),
  ('booking.cancel:org'),
  ('booking.block_time:org'),
  ('client.create'),
  ('client.read:contact'),
  ('client.read:full'),
  ('client.merge'),
  ('client.export'),
  ('clinical_note.read:own'),
  ('payment.charge'),
  ('payment.refund'),
  ('payment.discount:limited'),
  ('payment.discount:unlimited'),
  ('payment.shift.close'),
  ('staff.invite'),
  ('staff.update'),
  ('staff.deactivate'),
  ('staff.schedule.manage:org'),
  ('staff.commission.read'),
  ('service.manage'),
  ('service.price.manage'),
  ('resource.manage:org'),
  ('report.own'),
  ('report.branch'),
  ('org.settings.update:org'),
  ('org.branch.manage'),
  ('audit.read')
) AS t(perm)
WHERE r.key = 'ORG_ADMIN' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- BRANCH_MANAGER
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('booking.create'),
  ('booking.read:branch'),
  ('booking.update:branch'),
  ('booking.cancel:branch'),
  ('booking.block_time:branch'),
  ('client.create'),
  ('client.read:contact'),
  ('client.read:full'),
  ('payment.charge'),
  ('payment.discount:limited'),
  ('payment.shift.close'),
  ('staff.invite'),
  ('staff.update'),
  ('staff.deactivate'),
  ('staff.schedule.manage:branch'),
  ('resource.manage:branch'),
  ('report.own'),
  ('report.branch'),
  ('org.settings.update:branch')
) AS t(perm)
WHERE r.key = 'BRANCH_MANAGER' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- FRONT_DESK
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('booking.create'),
  ('booking.read:branch'),
  ('booking.update:branch'),
  ('booking.cancel:branch'),
  ('booking.block_time:branch'),
  ('client.create'),
  ('client.read:contact'),
  ('payment.charge'),
  ('payment.shift.close'),
  ('report.own')
) AS t(perm)
WHERE r.key = 'FRONT_DESK' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- PROVIDER
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('booking.create'),
  ('booking.read:own'),
  ('booking.update:own'),
  ('booking.cancel:own'),
  ('booking.block_time:own'),
  ('client.create'),
  ('client.read:contact'),
  ('clinical_note.create'),
  ('clinical_note.read:own'),
  ('clinical_note.attachment.manage'),
  ('staff.schedule.manage:own'),
  ('staff.commission.read'),
  ('report.own')
) AS t(perm)
WHERE r.key = 'PROVIDER' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- SENIOR_PROVIDER
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('booking.create'),
  ('booking.read:branch'),
  ('booking.update:own'),
  ('booking.cancel:own'),
  ('booking.block_time:own'),
  ('client.create'),
  ('client.read:contact'),
  ('clinical_note.create'),
  ('clinical_note.read:own'),
  ('clinical_note.attachment.manage'),
  ('staff.schedule.manage:branch'),
  ('staff.commission.read'),
  ('report.own'),
  ('report.branch')
) AS t(perm)
WHERE r.key = 'SENIOR_PROVIDER' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- ACCOUNTANT
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('report.branch'),
  ('report.financial:org'),
  ('report.payroll'),
  ('report.export'),
  ('org.billing.read'),
  ('staff.commission.read')
) AS t(perm)
WHERE r.key = 'ACCOUNTANT' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- MARKETING
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, t.perm
FROM roles r
CROSS JOIN (VALUES
  ('client.read:contact'),
  ('report.own'),
  ('report.branch')
) AS t(perm)
WHERE r.key = 'MARKETING' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- CLIENT: no permissions (spec §4.3 — access by ownership only).

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Ensure levaaani@gmail.com is a SUPER_ADMIN with credentials.
--    Now that the SUPER_ADMIN role is guaranteed to exist, all prior
--    NOT EXISTS guards are moot.
--
--    Case A: user exists → unconditionally set password + platform role.
--    Case B: user does not exist AND no other SUPER_ADMIN → INSERT.
--    (Case B guard on "no other SUPER_ADMIN" prevents a duplicate in
--    dev/CI where superadmin@bp.test is already seeded.)
-- ─────────────────────────────────────────────────────────────────────────────

-- Case A
UPDATE app_users
   SET password_hash    = '$argon2id$v=19$m=19456,t=2,p=1$sWwZ73KLKQZ4ed4nXHRCbg$kgQKBGOj3L13oFwS053u+djbVc0CwUBtiNhYGuS2myM',
       platform_role_id = (SELECT id FROM roles WHERE key = 'SUPER_ADMIN' AND organization_id IS NULL),
       auth_provider    = 'credentials',
       auth_subject     = 'levaaani@gmail.com',
       mfa_enabled      = false
 WHERE email = 'levaaani@gmail.com';

-- Case B
INSERT INTO app_users (
  id, auth_provider, auth_subject, email, full_name,
  password_hash, platform_role_id, mfa_enabled, created_at
)
SELECT
  gen_random_uuid(),
  'credentials',
  'levaaani@gmail.com',
  'levaaani@gmail.com',
  'Levan Tchanturidze',
  '$argon2id$v=19$m=19456,t=2,p=1$sWwZ73KLKQZ4ed4nXHRCbg$kgQKBGOj3L13oFwS053u+djbVc0CwUBtiNhYGuS2myM',
  r.id,
  false,
  now()
FROM roles r
WHERE r.key = 'SUPER_ADMIN' AND r.organization_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM app_users WHERE email = 'levaaani@gmail.com')
  AND NOT EXISTS (SELECT 1 FROM app_users WHERE platform_role_id = r.id);
