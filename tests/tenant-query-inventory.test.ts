import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory, type QuerySite } from '@/scripts/tenant-query-inventory';

// -----------------------------------------------------------------------------
// DEF-08: a query on the RLS-bypassing client that names no organisation has
// NOTHING enforcing its tenant boundary. Each one in the code today was read
// and its key traced (docs/tenant-isolation-audit.md §4). This list is that
// review. A new one fails here until someone does the same for it: name the
// organisation, or add it below with the reason the audit doc records.
//
// Keyed by file, function and query, not line numbers, so unrelated edits do
// not disturb it. The count is per key. A key that disappears also fails, so
// the list cannot drift into describing code that no longer exists.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

const SYSTEM = 'system job over every organisation by design; no request input reaches it';
const ACTOR =
  'keyed to the acting user (session user id, or the actor session id from their own auth context)';
const TOKEN = "keyed by a secret token's hash; the organisation is read from the token's own row";
const SIGNED = "keyed by an id from the payment gateway's signature-verified callback";
const VALIDATED =
  'keyed by an id this path already proved belongs to the organisation (an org-filtered read upstream)';
const CREATES_ORG = 'creates the organisation itself';
const PLATFORM =
  'platform plane, behind a platform permission; operates across organisations by design';
const PUBLIC_SLUG =
  "keyed by the location's public booking slug; the organisation is the location's own";

const REVIEWED_BYPASS: Record<string, { count: number; why: string }> = {
  'app/api/cron/reminders/route.ts :: POST :: organization.count': { count: 1, why: SYSTEM },
  'lib/admin/ownership-transfer.ts :: acceptTransfer :: membership.update': {
    count: 2,
    why: "memberships found under the transfer row's organisation, the transfer pinned to the nominee",
  },
  'lib/admin/ownership-transfer.ts :: acceptTransfer :: ownershipTransfer.findFirst': {
    count: 1,
    why: ACTOR,
  },
  'lib/admin/ownership-transfer.ts :: acceptTransfer :: ownership_transfers.$executeRaw': {
    count: 2,
    why: VALIDATED,
  },
  'lib/admin/ownership-transfer.ts :: declineTransfer :: ownershipTransfer.findFirst': {
    count: 1,
    why: ACTOR,
  },
  'lib/admin/ownership-transfer.ts :: declineTransfer :: ownershipTransfer.update': {
    count: 1,
    why: VALIDATED,
  },
  'lib/admin/ownership-transfer.ts :: revokeTransfer :: ownershipTransfer.findFirst': {
    count: 1,
    why: ACTOR,
  },
  'lib/admin/ownership-transfer.ts :: revokeTransfer :: ownershipTransfer.update': {
    count: 1,
    why: VALIDATED,
  },
  'lib/admin/ownership-transfer.ts :: unexpiredPendingTransferIds :: ownership_transfers.$queryRaw':
    { count: 2, why: ACTOR },
  'lib/gdpr.ts :: runRetentionTick :: customer.update': {
    count: 1,
    why: 'retention sweep for one organisation; the ids come from its org-filtered candidate read',
  },
  'lib/housekeeping.ts :: runHousekeeping :: break_glass_sessions.$executeRaw': {
    count: 1,
    why: SYSTEM,
  },
  'lib/housekeeping.ts :: runHousekeeping :: impersonation_sessions.$executeRaw': {
    count: 1,
    why: SYSTEM,
  },
  'lib/housekeeping.ts :: runHousekeeping :: notifications.$executeRaw': { count: 1, why: SYSTEM },
  'lib/housekeeping.ts :: runHousekeeping :: rate_limit.$executeRaw': { count: 1, why: SYSTEM },
  'lib/invitations.ts :: acceptInvitation :: invitation.findUnique': { count: 1, why: TOKEN },
  'lib/invitations.ts :: acceptInvitation :: invitation.update': { count: 1, why: TOKEN },
  'lib/invitations.ts :: acceptInvitation :: invitations.$executeRaw': { count: 1, why: TOKEN },
  'lib/messaging/reminders.ts :: claim :: appointments.$executeRaw': { count: 1, why: VALIDATED },
  'lib/messaging/reminders.ts :: prepare :: appointment.findUnique': { count: 1, why: VALIDATED },
  'lib/messaging/reminders.ts :: prepare :: messageLog.findFirst': { count: 1, why: VALIDATED },
  'lib/messaging/reminders.ts :: sendForAppointment :: messageLog.update': {
    count: 2,
    why: VALIDATED,
  },
  'lib/onboarding.ts :: activatePendingRegistration :: organization.create': {
    count: 1,
    why: CREATES_ORG,
  },
  'lib/onboarding.ts :: onboardOrg :: organization.create': { count: 1, why: CREATES_ORG },
  'lib/ops-metrics.ts :: collectOpsMetrics :: customers.$queryRaw': {
    count: 1,
    why: `${SYSTEM}; counts only, no row leaves the query`,
  },
  'lib/ops-metrics.ts :: collectOpsMetrics :: rate_limit.$queryRaw': {
    count: 1,
    why: `${SYSTEM}; counts only, no row leaves the query`,
  },
  'lib/payments/service.ts :: applyWebhook :: appointment.update': { count: 1, why: SIGNED },
  'lib/payments/service.ts :: applyWebhook :: payment.findUnique': { count: 1, why: SIGNED },
  'lib/payments/service.ts :: applyWebhook :: payment.update': { count: 1, why: SIGNED },
  'lib/platform/break-glass.ts :: endBreakGlass :: break_glass_sessions.$executeRaw': {
    count: 1,
    why: ACTOR,
  },
  'lib/platform/break-glass.ts :: runBreakGlassTx :: break_glass_sessions.$executeRaw': {
    count: 1,
    why: ACTOR,
  },
  'lib/platform/break-glass.ts :: runBreakGlassTx :: break_glass_sessions.$queryRaw': {
    count: 1,
    why: ACTOR,
  },
  'lib/platform/impersonation.ts :: endImpersonation :: impersonationSession.update': {
    count: 1,
    why: ACTOR,
  },
  'lib/platform/impersonation.ts :: startImpersonation :: impersonation_sessions.$queryRaw': {
    count: 1,
    why: ACTOR,
  },
  'lib/platform/orgs.ts :: changeOrganizationOwner :: membership.update': {
    count: 1,
    why: `${PLATFORM}; the membership is found under the target organisation`,
  },
  'lib/platform/orgs.ts :: listOrganizations :: organization.findMany': {
    count: 1,
    why: PLATFORM,
  },
  'lib/public-booking.ts :: submitPublicBooking :: customer.update': {
    count: 1,
    why: "the customer was matched under the booking location's organisation",
  },
  'lib/rbac/context.ts :: loadActiveBreakGlass :: break_glass_sessions.$queryRaw': {
    count: 1,
    why: ACTOR,
  },
  // Counted as naming the organisation until the classifier read only the
  // predicate (Codex review on #128): each selects or includes an organisation
  // field without filtering by it. Each was then read like the rest.
  'app/api/cron/reminders/route.ts :: POST :: organization.findMany': { count: 1, why: SYSTEM },
  'app/api/cron/retention/route.ts :: POST :: organization.findMany': { count: 1, why: SYSTEM },
  'lib/audit-digest.ts :: runDigestForAllOrgs :: organization.findMany': { count: 1, why: SYSTEM },
  'lib/ops-metrics.ts :: collectOpsMetrics :: appointments+customers+organizations.$queryRaw': {
    count: 1,
    why: `${SYSTEM}; counts only, no row leaves the query`,
  },
  'lib/ops-metrics.ts :: collectOpsMetrics :: appointments+message_log+organizations.$queryRaw': {
    count: 1,
    why: `${SYSTEM}; counts only, no row leaves the query`,
  },
  'lib/ops-metrics.ts :: collectOpsMetrics :: customers+memberships+organizations.$queryRaw': {
    count: 1,
    why: `${SYSTEM}; counts only, no row leaves the query`,
  },
  'lib/admin/ownership-transfer.ts :: pendingTransfersForNominee :: ownershipTransfer.findMany': {
    count: 1,
    why: ACTOR,
  },
  'lib/admin/ownership-transfer.ts :: pendingTransfersFromNominator :: ownershipTransfer.findMany':
    { count: 1, why: ACTOR },
  'lib/billing/service.ts :: lookupOrgByCustomer :: organization.findUnique': {
    count: 1,
    why: "keyed by the customer id from Stripe's signature-verified webhook event",
  },
  'lib/org-switch.ts :: listUserMemberships :: membership.findMany': {
    count: 1,
    why: `${ACTOR}: the session user's own memberships`,
  },
  'lib/platform/audit.ts :: queryPlatformAudit :: auditLog.findMany': { count: 1, why: PLATFORM },
  'lib/platform/orgs.ts :: createOrganization :: organization.create': {
    count: 1,
    why: `${CREATES_ORG} (platform plane)`,
  },
  'lib/public-booking.ts :: getPublicLocation :: location.findUnique': {
    count: 1,
    why: PUBLIC_SLUG,
  },
  'lib/rbac/context.ts :: buildOrgContext :: membership.findUnique': {
    count: 1,
    why: "the session's own membership; refused unless its userId is the signed-in user",
  },
  'lib/rbac/context.ts :: loadActiveImpersonation :: impersonation_sessions.$queryRaw': {
    count: 1,
    why: ACTOR,
  },
};

const keyOf = (s: QuerySite) => `${s.file} :: ${s.fn} :: ${s.target}.${s.op}`;

function countUnnamed(sites: QuerySite[], context: QuerySite['context']) {
  const out: Record<string, number> = {};
  for (const s of sites) {
    if (s.context !== context || s.orgNamed) continue;
    out[keyOf(s)] = (out[keyOf(s)] ?? 0) + 1;
  }
  return out;
}

describe('DEF-08: tenant query inventory', () => {
  const sites = inventory(ROOT);

  it('every bypass-client query that names no organisation has been reviewed', () => {
    const actual = countUnnamed(sites, 'bypass');
    const unreviewed = Object.entries(actual)
      .filter(([k, n]) => n > (REVIEWED_BYPASS[k]?.count ?? 0))
      .map(([k, n]) => `${k} (${n}, reviewed ${REVIEWED_BYPASS[k]?.count ?? 0})`);
    expect(
      unreviewed,
      'A query on the RLS-bypassing client names no organisation, and nothing else filters ' +
        'it. Name the organisation in the query, or review it and add it to REVIEWED_BYPASS ' +
        'with the reason (docs/tenant-isolation-audit.md §4).',
    ).toEqual([]);
    const stale = Object.entries(REVIEWED_BYPASS)
      .filter(([k, v]) => (actual[k] ?? 0) < v.count)
      .map(([k, v]) => `${k} (reviewed ${v.count}, now ${actual[k] ?? 0})`);
    expect(stale, 'Reviewed entries that no longer exist: remove them.').toEqual([]);
  });

  it('every query site gets a context the tool can name', () => {
    // An `unknown` context means the classifier could not tell what enforces
    // the boundary — a human has to. `app-no-org` (prismaApp with no org set)
    // fails closed, but nothing in the code should rely on that by accident.
    const unplaced = sites
      .filter((s) => s.context === 'unknown' || s.context === 'app-no-org')
      .map((s) => `${s.file}:${s.line} ${s.target}.${s.op} via ${s.receiver} (${s.context})`);
    expect(unplaced).toEqual([]);
  });

  it('the authorisation resolvers name the organisation in every query', () => {
    // The behaviour is proven in tests/tenant-scope-resolvers.test.ts with RLS
    // taken away. This keeps a new resolver from arriving without the filter.
    const unnamed = sites
      .filter((s) => s.file === 'lib/rbac/scope.ts' && !s.orgNamed)
      .map((s) => `${s.fn} ${s.target}.${s.op}`);
    expect(unnamed).toEqual([]);
  });
});

// The ratchet above is only as good as the classifier. These cases pin it, so
// a broken classifier fails loudly instead of letting every query through.
describe('the inventory classifier', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tenant-inventory-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function classify(source: string): QuerySite[] {
    rmSync(path.join(dir, 'lib'), { recursive: true, force: true });
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    mkdirSync(path.join(dir, 'components'), { recursive: true });
    writeFileSync(path.join(dir, 'lib', 'sample.ts'), source);
    return inventory(dir);
  }

  it('tells RLS, bypass and a caller-supplied client apart', () => {
    const sites = classify(`
      export async function a(id: string, orgId: string) {
        await withOrg(orgId, (tx) => tx.customer.findUnique({ where: { id } }));
        await withoutRls((tx) => tx.customer.findUnique({ where: { id } }));
        await unsafePrismaAdmin.customer.delete({ where: { id } });
      }
      export async function b(tx: TxClient, id: string) {
        return tx.appointment.update({ where: { id }, data: { notes: null } });
      }
    `);
    expect(sites.map((s) => [s.target, s.op, s.context, s.orgNamed, s.byId])).toEqual([
      ['customer', 'findUnique', 'rls', false, true],
      ['customer', 'findUnique', 'bypass', false, true],
      ['customer', 'delete', 'bypass', false, true],
      ['appointment', 'update', 'caller-tx', false, true],
    ]);
  });

  it('sees an organisation filter, including one in a reused SQL fragment', () => {
    const sites = classify(`
      export async function c(tx: TxClient, id: string, organizationId: string) {
        await tx.customer.findFirst({ where: { id, organizationId } });
        const scoped = \`c.organization_id = $1::uuid\`;
        await tx.$queryRawUnsafe(\`SELECT c.id FROM customers c WHERE \${scoped}\`, organizationId);
        await tx.$queryRawUnsafe(\`SELECT c.id FROM customers c WHERE c.id = $1\`, id);
      }
    `);
    expect(sites.map((s) => [s.kind, s.target, s.orgNamed])).toEqual([
      ['prisma', 'customer', true],
      ['sql', 'customers', true],
      ['sql', 'customers', false],
    ]);
  });

  it('reads the organisation from the predicate, never from what is selected (Codex review on #128)', () => {
    const sites = classify(`
      export async function e(id: string, organizationId: string) {
        await unsafePrismaAdmin.customer.findFirst({ where: { id }, select: { organizationId: true } });
        await unsafePrismaAdmin.customer.findMany({ include: { organization: true } });
        await unsafePrismaAdmin.customer.update({ where: { id }, data: { organizationId } });
        await unsafePrismaAdmin.$queryRaw\`SELECT organization_id FROM customers WHERE id = \${id}\`;
        await unsafePrismaAdmin.$executeRaw\`UPDATE customers SET organization_id = \${organizationId} WHERE id = \${id}\`;
        await unsafePrismaAdmin.$queryRaw\`SELECT a.id FROM appointments a JOIN customers c ON c.organization_id = a.organization_id WHERE a.id = \${id}\`;
        await unsafePrismaAdmin.$queryRaw\`DELETE FROM customers WHERE id = \${id} RETURNING organization_id\`;
      }
    `);
    expect(sites.map((s) => s.orgNamed)).toEqual([false, false, false, false, false, false, false]);
  });

  it('COMPLEMENT: a predicate on the organisation is still seen, in every form', () => {
    const sites = classify(`
      export async function f(id: string, organizationId: string, userId: string) {
        await unsafePrismaAdmin.customer.findFirst({ where: { id, organizationId } });
        await unsafePrismaAdmin.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
        await unsafePrismaAdmin.customer.create({ data: { organizationId, name: 'x' } });
        await unsafePrismaAdmin.$queryRaw\`SELECT id FROM customers WHERE organization_id = \${organizationId}::uuid\`;
        await unsafePrismaAdmin.$queryRaw\`SELECT a.id FROM appointments a WHERE a.organization_id = ANY(\${[organizationId]})\`;
        await unsafePrismaAdmin.$executeRaw\`INSERT INTO customers (organization_id, name) VALUES (\${organizationId}, 'x')\`;
        await unsafePrismaAdmin.$queryRaw\`SELECT status FROM organizations WHERE id = \${organizationId}::uuid FOR SHARE\`;
      }
    `);
    expect(sites.map((s) => s.orgNamed)).toEqual([true, true, true, true, true, true, true]);
  });

  it('does not count a captured outer client inside withOrg as RLS-scoped', () => {
    // withOrg only scopes the client it hands to its callback.
    const sites = classify(`
      export async function d(orgId: string, id: string) {
        await withOrg(orgId, async () => unsafePrismaAdmin.waitlist.delete({ where: { id } }));
      }
    `);
    expect(sites.map((s) => s.context)).toEqual(['bypass']);
  });
});
