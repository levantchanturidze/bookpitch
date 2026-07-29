import { createInterface, Interface } from 'node:readline';
import { config as loadEnv } from 'dotenv';

// Load .env then override with .env.local (matches prisma/seed.ts). Callers
// running against a remote DB pass DATABASE_URL inline so neither file is
// required — the explicit env-var check below covers that path.
loadEnv();
loadEnv({ path: '.env.local', override: true });

// -----------------------------------------------------------------------------
// scripts/create-platform-user.ts
//
// Bootstrap or reset a platform-plane user (SUPER_ADMIN, PLATFORM_ADMIN,
// SUPPORT_AGENT, BILLING_MANAGER). Spec §4.1.
//
// Usage (values via env, never CLI argv):
//
//   DATABASE_URL="$(grep '^ADMIN_DATABASE_URL' .env.supabase | cut -d= -f2- | tr -d '"')" \
//   npx tsx scripts/create-platform-user.ts <email> <role-key>
//
// Password is prompted silently (twice for confirmation), never echoed and
// never touches process.argv or shell history. Idempotent: re-running for
// the same email updates the password + role + bumps sessionVersion so any
// live JWT for that user is invalidated within ~5s.
//
// SECURITY NOTES
//   • Spec CLAUDE.md invariant #6 says "Admins never set passwords." This
//     script is the BOOTSTRAP exception — used once per environment to
//     create the first SUPER_ADMIN, from a trusted operator's laptop.
//     Any subsequent password change MUST go through the reset-link flow.
//   • Only writes to app_users. Never touches memberships / organizations
//     / audit_log.
//   • mfa_enabled is set to true — no MFA enforcement code ships in the
//     MVP, but the flag surfaces the intent + is picked up when MFA lands
//     (see lib/platform/break-glass.ts::startBreakGlass TODO).
// -----------------------------------------------------------------------------

const ALLOWED_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_AGENT',
  'BILLING_MANAGER',
] as const;

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`Usage: npx tsx scripts/create-platform-user.ts <email> <role-key>`);
  console.error(`role-key ∈ { ${ALLOWED_ROLES.join(', ')} }`);
  process.exit(1);
}

async function promptPassword(label: string): Promise<string> {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(label);
  // Mute stdout so keystrokes don't echo. Standard node.js pattern.
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
  return new Promise<string>((resolve) => {
    rl.question('', (answer) => {
      (process.stdout as unknown as { write: (s: string) => boolean }).write = originalWrite;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  // Argv + env validated BEFORE importing @/lib/db so bad inputs fail with
  // a helpful message instead of a Prisma connection error.
  const [email, roleKey] = process.argv.slice(2);
  if (!email || !roleKey) usage('missing email or role-key');
  if (!email.includes('@')) usage('email must contain @');
  if (!(ALLOWED_ROLES as readonly string[]).includes(roleKey)) {
    usage(`role-key must be one of: ${ALLOWED_ROLES.join(', ')}`);
  }
  if (!process.env.DATABASE_URL) {
    usage('DATABASE_URL is not set (pass it inline or via .env.local)');
  }

  const { hash } = await import('@node-rs/argon2');
  const { prismaAdmin } = await import('@/lib/db');

  const role = await prismaAdmin.role.findFirst({
    where: { key: roleKey, organizationId: null },
    select: { id: true },
  });
  if (!role) {
    console.error(
      `error: role '${roleKey}' not found. Has the RBAC seed (prisma/rbac-seed.ts) run against this database?`,
    );
    process.exit(1);
  }

  const password = await promptPassword(`password for ${email}: `);
  if (password.length < 12) {
    console.error('error: password must be at least 12 characters');
    process.exit(1);
  }
  const confirm = await promptPassword('confirm password: ');
  if (password !== confirm) {
    console.error('error: passwords do not match');
    process.exit(1);
  }

  const passwordHash = await hash(password);
  const existing = await prismaAdmin.appUser.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    await prismaAdmin.appUser.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        platformRoleId: role.id,
        mfaEnabled: true,
        status: 'active',
        sessionVersion: { increment: 1 },
      },
    });
    console.log(`✔ updated ${email} → ${roleKey} (sessionVersion bumped)`);
  } else {
    const created = await prismaAdmin.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: email,
        email,
        fullName: `Platform ${roleKey}`,
        passwordHash,
        platformRoleId: role.id,
        mfaEnabled: true,
      },
      select: { id: true },
    });
    console.log(`✔ created ${email} → ${roleKey} (id=${created.id})`);
  }

  await prismaAdmin.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
