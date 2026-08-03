import { describe, it, expect, beforeAll } from 'vitest';
import { unsafePrismaAdmin } from '@/lib/db';
import { seedRbac } from '@/prisma/rbac-seed';

// -----------------------------------------------------------------------------
// Phase 1 seed invariants:
//   • Every spec §4 system role exists with the right plane + rank.
//   • Every permission key from the seed is present.
//   • Role → permission mapping is what the code says it is (SUPER_ADMIN gets
//     everything, CLIENT gets nothing, sample rows for OWNER/ADMIN).
//   • Re-running the seed leaves the state byte-identical.
// -----------------------------------------------------------------------------

describe('RBAC seed', () => {
  beforeAll(async () => {
    // Ensure the seed has been run at least once.
    await seedRbac();
  });

  it('seeds every system role from spec §4', async () => {
    const rows = await unsafePrismaAdmin.role.findMany({
      where: { isSystem: true, organizationId: null },
      orderBy: [{ plane: 'asc' }, { rank: 'desc' }],
      select: { key: true, plane: true, rank: true },
    });
    const byPlane = new Map<string, Array<{ key: string; rank: number }>>();
    for (const r of rows) {
      if (!byPlane.has(r.plane)) byPlane.set(r.plane, []);
      byPlane.get(r.plane)!.push({ key: r.key, rank: r.rank });
    }
    // Platform plane: 4 roles.
    expect(byPlane.get('platform')?.map(r => r.key).sort()).toEqual(
      ['BILLING_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'],
    );
    // Org plane: 8 roles including optionals.
    expect(byPlane.get('organization')?.map(r => r.key).sort()).toEqual(
      ['ACCOUNTANT', 'BRANCH_MANAGER', 'FRONT_DESK', 'MARKETING',
       'ORG_ADMIN', 'ORG_OWNER', 'PROVIDER', 'SENIOR_PROVIDER'],
    );
    // Consumer plane: CLIENT marker.
    expect(byPlane.get('consumer')?.map(r => r.key)).toEqual(['CLIENT']);
    // SUPER_ADMIN outranks everyone.
    const superAdmin = rows.find(r => r.key === 'SUPER_ADMIN')!;
    expect(superAdmin.rank).toBeGreaterThan(rows.filter(r => r.key !== 'SUPER_ADMIN')
                                                 .reduce((m, r) => Math.max(m, r.rank), 0));
  });

  it('SUPER_ADMIN holds every permission (spec §4.1 — no ceiling)', async () => {
    const superRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'SUPER_ADMIN', organizationId: null },
    });
    const bundle = await unsafePrismaAdmin.rolePermission.count({ where: { roleId: superRole.id } });
    const total = await unsafePrismaAdmin.permission.count();
    expect(bundle).toBe(total);
    expect(total).toBeGreaterThan(50); // sanity: enumeration didn't disappear
  });

  it('CLIENT holds zero permissions (spec §4.3)', async () => {
    const clientRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'CLIENT', organizationId: null },
    });
    const bundle = await unsafePrismaAdmin.rolePermission.count({ where: { roleId: clientRole.id } });
    expect(bundle).toBe(0);
  });

  it('ORG_OWNER holds org.billing.manage but ORG_ADMIN does not (spec §2.1)', async () => {
    const [owner, admin] = await Promise.all([
      unsafePrismaAdmin.role.findFirstOrThrow({ where: { key: 'ORG_OWNER',  organizationId: null } }),
      unsafePrismaAdmin.role.findFirstOrThrow({ where: { key: 'ORG_ADMIN',  organizationId: null } }),
    ]);
    const ownerHas = await unsafePrismaAdmin.rolePermission.findFirst({
      where: { roleId: owner.id, permissionKey: 'org.billing.manage' },
    });
    const adminHas = await unsafePrismaAdmin.rolePermission.findFirst({
      where: { roleId: admin.id, permissionKey: 'org.billing.manage' },
    });
    expect(ownerHas).toBeTruthy();
    expect(adminHas).toBeNull();
  });

  it('PROVIDER cannot read other clinicians\' notes by default (⚙️, spec §6.2)', async () => {
    const provider = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'PROVIDER', organizationId: null },
    });
    const readAny = await unsafePrismaAdmin.rolePermission.findFirst({
      where: { roleId: provider.id, permissionKey: 'clinical_note.read:any' },
    });
    expect(readAny).toBeNull();
    // But own-notes reading IS allowed.
    const readOwn = await unsafePrismaAdmin.rolePermission.findFirst({
      where: { roleId: provider.id, permissionKey: 'clinical_note.read:own' },
    });
    expect(readOwn).toBeTruthy();
  });

  it('re-running the seed is a no-op (idempotency)', async () => {
    // Take a fingerprint keyed on the (role.key, permission.key) pairs.
    const fingerprint = async () => {
      const rows = await unsafePrismaAdmin.$queryRaw<Array<{ role_key: string; permission_key: string }>>`
        SELECT r.key AS role_key, rp.permission_key
          FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id AND r.organization_id IS NULL
         ORDER BY r.key, rp.permission_key
      `;
      return rows.map(r => `${r.role_key}::${r.permission_key}`).join('\n');
    };
    const before = await fingerprint();
    await seedRbac();
    const after = await fingerprint();
    expect(after).toBe(before);
    // Row counts unchanged too (nothing was inserted or deleted).
    const [roles, perms, rp] = await Promise.all([
      unsafePrismaAdmin.role.count({ where: { isSystem: true, organizationId: null } }),
      unsafePrismaAdmin.permission.count(),
      unsafePrismaAdmin.rolePermission.count(),
    ]);
    expect({ roles, perms, rp }).toEqual({ roles: 13, perms: 67, rp: 214 });
  });
});
