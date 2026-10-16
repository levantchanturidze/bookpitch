import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The page reads the active location from a cookie; the test chooses it.
const { locationMock } = vi.hoisted(() => ({ locationMock: vi.fn() }));
vi.mock('@/lib/active-location', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/active-location')>('@/lib/active-location');
  return { ...actual, loadLocationsForOrg: locationMock };
});

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { ForbiddenError, InvalidInputError } = await import('@/lib/auth');
const { saveTemplateAction, saveLeadHoursAction } = await import('@/components/reminders/actions');
const remindersPage = await import('@/app/(app)/reminders/page');

// -----------------------------------------------------------------------------
// Backlog B — reminder templates and lead time are ORGANISATION-WIDE settings.
//
// They were gated by `booking.update` in list mode, so any PROVIDER or
// FRONT_DESK could rewrite the text sent to every customer of the organisation,
// or shorten the lead time for all of them (scoped-RBAC audit §7). The lead
// time change also wrote no audit row. Both now require org.settings.update:org
// — the gate the retention and tick actions on the same page already use.
//
// Every refusal is asserted on DATABASE state and the audit log, not only on
// the thrown error, and sits beside the allowed twin.
// -----------------------------------------------------------------------------

type Role = 'owner' | 'admin' | 'provider' | 'frontDesk' | 'branchManager';
type Fx = {
  orgId: string;
  otherOrgId: string;
  locationId: string;
  users: Record<Role | 'otherOwner', string>;
  templates: { sms: string; email: string; otherSms: string };
};
let fx: Fx;
const ts = Date.now();
const createdUsers: string[] = [];
const ORIGINAL_SMS = 'Hi {PatientName} — original SMS';
const OTHER_SMS = 'Other org SMS — must never change here';

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function as(who: Role | 'otherOwner') {
  const org = who === 'otherOwner' ? fx.otherOrgId : fx.orgId;
  authMock.mockResolvedValue(await mockJwt(fx.users[who], org));
}
async function smsBody(orgId = fx.orgId) {
  return (
    await unsafePrismaAdmin.messageTemplate.findFirstOrThrow({
      where: { organizationId: orgId, channel: 'sms' },
      select: { body: true },
    })
  ).body;
}
async function leadHours(orgId = fx.orgId) {
  return (
    await unsafePrismaAdmin.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { reminderLeadHours: true },
    })
  ).reminderLeadHours;
}
async function settingsAudits(orgId = fx.orgId) {
  return unsafePrismaAdmin.auditLog.findMany({
    where: { organizationId: orgId, entity: { in: ['message_template', 'organization'] } },
    orderBy: { at: 'asc' },
    select: { action: true, entity: true, entityId: true, actorUserId: true, meta: true },
  });
}
function findProp<T>(el: unknown, key: string): T | undefined {
  if (!el || typeof el !== 'object') return undefined;
  const props = (el as { props?: Record<string, unknown> }).props;
  if (!props) return undefined;
  if (key in props) return props[key] as T;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const c of children) {
    const hit = findProp<T>(c, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

beforeAll(async () => {
  fx = await withoutRls(async (tx) => {
    const role = async (key: string) =>
      (
        await tx.role.findFirstOrThrow({
          where: { key, organizationId: null },
          select: { id: true },
        })
      ).id;
    const org = await tx.organization.create({ data: { name: `RS Org ${ts}` } });
    const other = await tx.organization.create({ data: { name: `RS Other ${ts}` } });
    const user = async (tag: string) => {
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `rs-${tag}-${ts}@bookpitch.dev`,
          email: `rs-${tag}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
      createdUsers.push(u.id);
      return u.id;
    };
    const member = async (
      orgId: string,
      userId: string,
      legacy: 'owner' | 'practitioner' | 'receptionist',
      roleKey: string,
    ) =>
      tx.membership.create({
        data: { organizationId: orgId, userId, role: legacy, roleId: await role(roleKey) },
      });

    const users = {
      owner: await user('owner'),
      admin: await user('admin'),
      provider: await user('provider'),
      frontDesk: await user('fd'),
      branchManager: await user('bm'),
      otherOwner: await user('other-owner'),
    };
    await member(org.id, users.owner, 'owner', 'ORG_OWNER');
    await member(org.id, users.admin, 'owner', 'ORG_ADMIN');
    await member(org.id, users.provider, 'practitioner', 'PROVIDER');
    await member(org.id, users.frontDesk, 'receptionist', 'FRONT_DESK');
    await member(org.id, users.branchManager, 'receptionist', 'BRANCH_MANAGER');
    await member(other.id, users.otherOwner, 'owner', 'ORG_OWNER');
    await tx.organization.update({ where: { id: org.id }, data: { ownerUserId: users.owner } });
    await tx.organization.update({
      where: { id: other.id },
      data: { ownerUserId: users.otherOwner },
    });
    const location = await tx.location.create({
      data: { organizationId: org.id, type: 'clinic', name: 'RS Clinic' },
    });
    const sms = await tx.messageTemplate.create({
      data: { organizationId: org.id, channel: 'sms', body: ORIGINAL_SMS },
    });
    const email = await tx.messageTemplate.create({
      data: { organizationId: org.id, channel: 'email', body: 'original email' },
    });
    const otherSms = await tx.messageTemplate.create({
      data: { organizationId: other.id, channel: 'sms', body: OTHER_SMS },
    });
    return {
      orgId: org.id,
      otherOrgId: other.id,
      locationId: location.id,
      users,
      templates: { sms: sms.id, email: email.id, otherSms: otherSms.id },
    };
  });
});

afterAll(async () => {
  if (!fx) return;
  const orgs = [fx.orgId, fx.otherOrgId];
  await withoutRls(async (tx) => {
    await tx.messageTemplate.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.location.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.membership.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.organization.updateMany({ where: { id: { in: orgs } }, data: { ownerUserId: null } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs(orgs);
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: { in: createdUsers } } });
    await tx.organization.deleteMany({ where: { id: { in: orgs } } });
  });
});

beforeEach(async () => {
  authMock.mockReset();
  __clearAuthContextCache();
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.orgId, fx.otherOrgId]);
  await unsafePrismaAdmin.messageTemplate.update({
    where: { id: fx.templates.sms },
    data: { body: ORIGINAL_SMS },
  });
  await unsafePrismaAdmin.messageTemplate.update({
    where: { id: fx.templates.otherSms },
    data: { body: OTHER_SMS },
  });
  await unsafePrismaAdmin.organization.updateMany({
    where: { id: { in: [fx.orgId, fx.otherOrgId] } },
    data: { reminderLeadHours: 24 },
  });
});

// -----------------------------------------------------------------------------
describe('saveTemplateAction — who may change what every customer is sent', () => {
  it.each(['owner', 'admin'] as const)('%s saves it, and the change is audited', async (who) => {
    await as(who);
    await saveTemplateAction(fd({ channel: 'sms', body: `new text by ${who}` }));
    expect(await smsBody()).toBe(`new text by ${who}`);
    expect(await settingsAudits()).toEqual([
      {
        action: 'update',
        entity: 'message_template',
        entityId: fx.templates.sms,
        actorUserId: fx.users[who],
        // The channel only. The body is customer-facing text the audit log has
        // no need to copy, and nothing secret belongs in meta.
        meta: { channel: 'sms' },
      },
    ]);
  });

  it.each(['provider', 'frontDesk', 'branchManager'] as const)(
    '%s is refused — the template is unchanged and nothing is audited',
    async (who) => {
      await as(who);
      await expect(
        saveTemplateAction(fd({ channel: 'sms', body: 'Click http://evil.example to confirm' })),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await smsBody()).toBe(ORIGINAL_SMS);
      expect(await settingsAudits()).toEqual([]);
    },
  );

  it('a member of ANOTHER organisation changes only their own — the session decides, not the form', async () => {
    await as('otherOwner');
    // A crafted field naming the victim organisation is simply not read.
    await saveTemplateAction(
      fd({ channel: 'sms', body: 'other org edit', organizationId: fx.orgId }),
    );
    expect(await smsBody(fx.otherOrgId)).toBe('other org edit');
    expect(await smsBody()).toBe(ORIGINAL_SMS);
    expect(await settingsAudits()).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('saveLeadHoursAction — who may decide when every customer is reminded', () => {
  it.each(['owner', 'admin'] as const)(
    '%s changes it, and the change is audited with the value it replaced',
    async (who) => {
      await as(who);
      await saveLeadHoursAction(fd({ hours: '12' }));
      expect(await leadHours()).toBe(12);
      expect(await settingsAudits()).toEqual([
        {
          action: 'update',
          entity: 'organization',
          entityId: fx.orgId,
          actorUserId: fx.users[who],
          meta: { setting: 'reminderLeadHours', hours: 12, previous: 24 },
        },
      ]);
    },
  );

  it.each(['provider', 'frontDesk', 'branchManager'] as const)(
    '%s is refused — the lead time is unchanged and nothing is audited',
    async (who) => {
      await as(who);
      await expect(saveLeadHoursAction(fd({ hours: '9' }))).rejects.toBeInstanceOf(ForbiddenError);
      expect(await leadHours()).toBe(24);
      expect(await settingsAudits()).toEqual([]);
    },
  );

  it('an invalid value from someone allowed changes nothing and audits nothing', async () => {
    await as('owner');
    await expect(saveLeadHoursAction(fd({ hours: '1' }))).rejects.toBeInstanceOf(InvalidInputError);
    expect(await leadHours()).toBe(24);
    expect(await settingsAudits()).toEqual([]);
  });

  it('another organisation changes only its own lead time', async () => {
    await as('otherOwner');
    await saveLeadHoursAction(fd({ hours: '48', organizationId: fx.orgId }));
    expect(await leadHours(fx.otherOrgId)).toBe(48);
    expect(await leadHours()).toBe(24);
    expect(await settingsAudits()).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('the /reminders page offers editing only to those who can save', () => {
  async function render(who: Role) {
    await as(who);
    locationMock.mockResolvedValue({
      locations: [{ id: fx.locationId, name: 'RS Clinic', type: 'clinic', timezone: 'UTC' }],
      active: { id: fx.locationId, name: 'RS Clinic', type: 'clinic', timezone: 'UTC' },
    });
    const el = (await remindersPage.default()) as ReactElement;
    return { el, html: renderToStaticMarkup(el) };
  }

  it.each(['owner', 'admin'] as const)('%s sees both editors', async (who) => {
    const { el, html } = await render(who);
    expect(findProp<boolean>(el, 'canEditSettings')).toBe(true);
    expect(html).toContain('Save template');
    expect(html).toContain('name="hours"');
  });

  it.each(['provider', 'frontDesk', 'branchManager'] as const)(
    '%s sees the settings read-only, with no control the server would refuse',
    async (who) => {
      const { el, html } = await render(who);
      expect(findProp<boolean>(el, 'canEditSettings')).toBe(false);
      expect(html).not.toContain('Save template');
      expect(html).not.toContain('name="hours"');
      expect(html).not.toContain('name="body"');
      // Still informed: what customers are sent, and when.
      expect(html).toContain('original SMS');
      expect(html).toMatch(/24<\/span> hours before/);
    },
  );
});

// -----------------------------------------------------------------------------
// The two actions above are the ONLY places these settings are written. A new
// writer would bypass the gate this file pins, so its appearance must be loud.
// -----------------------------------------------------------------------------
describe('there is no other write path to these settings', () => {
  const ROOT = path.resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  for (const d of ['app', 'lib', 'components']) walk(path.join(ROOT, d));

  const writers = (re: RegExp) =>
    files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));

  it('message templates are written only by saveTemplateAction', () => {
    expect(
      writers(/messageTemplate\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/),
    ).toEqual(['components/reminders/actions.ts']);
    expect(writers(/(INSERT INTO|UPDATE|DELETE FROM)\s+"?message_templates/i)).toEqual([]);
  });

  it('the lead time is written only by saveLeadHoursAction', () => {
    // A write names the field with a value; a read selects it with `true`.
    expect(writers(/reminderLeadHours:\s*(?!true\b)[\w(]/)).toEqual([
      'components/reminders/actions.ts',
    ]);
    // Case-sensitive on purpose: the column is lower case in SQL, and the
    // constant MIN_REMINDER_LEAD_HOURS is not a write.
    expect(writers(/\breminder_lead_hours\s*=/)).toEqual([]);
  });
});
