import { createInterface, Interface } from 'node:readline';
import { config as loadEnv } from 'dotenv';

// FOOTGUN NOTE (2026-07-30, learned the hard way):
// A prior version of this file did `loadEnv({ path: '.env.local', override: true })`
// unconditionally. That silently overwrote DATABASE_URL passed inline by the
// caller with .env.local's localhost URL — the first production bootstrap
// super-admin landed in the developer's local Postgres instead of Supabase.
// Rule: caller intent (explicit env var) always wins. Only fall back to the
// dotfiles when the caller hasn't provided DATABASE_URL.
if (!process.env.DATABASE_URL) {
  loadEnv();
  loadEnv({ path: '.env.local', override: true });
}

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
//   • Writes to app_users + one audit_log row per mint (F-03 fix). Never
//     touches memberships or organizations. Audit row has
//     actor_user_id=NULL (bootstrap has no signed-in caller); operator
//     context is captured in meta.
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
  const { unsafePrismaAdmin } = await import('@/lib/db');

  const role = await unsafePrismaAdmin.role.findFirst({
    where: { key: roleKey, organizationId: null },
    select: { id: true },
  });
  if (!role) {
    console.error(
      `error: role '${roleKey}' not found. Has the RBAC seed (prisma/rbac-seed.ts) run against this database?`,
    );
    process.exit(1);
  }

  // Password: prefer env var (BOOKPITCH_ADMIN_PASSWORD) so the caller
  // can drive this script from automation without wrestling with a
  // muted-stdout readline prompt. Env-var path skips the confirm step
  // by design — the caller is responsible for typing it right the
  // first time.
  //
  // SECURITY NOTE: a prefixed inline assignment like
  //   `BOOKPITCH_ADMIN_PASSWORD=foo npx tsx ...`
  // IS visible in shell history (it's part of the command line, not
  // a shell-builtin `export` scoped to a subshell). To keep the value
  // out of history, either
  //   (a) `export BOOKPITCH_ADMIN_PASSWORD=<value>` in a shell with
  //       HISTIGNORE='export*' or `set +o history` set, or
  //   (b) `read -rs BOOKPITCH_ADMIN_PASSWORD; export BOOKPITCH_ADMIN_PASSWORD`,
  //       or
  //   (c) stick to the interactive prompt path on a TTY.
  let password: string;
  if (process.env.BOOKPITCH_ADMIN_PASSWORD) {
    password = process.env.BOOKPITCH_ADMIN_PASSWORD;
  } else {
    password = await promptPassword(`password for ${email}: `);
    if (password.length < 12) {
      console.error('error: password must be at least 12 characters');
      process.exit(1);
    }
    const confirm = await promptPassword('confirm password: ');
    if (password !== confirm) {
      console.error('error: passwords do not match');
      process.exit(1);
    }
  }
  if (password.length < 12) {
    console.error('error: password must be at least 12 characters');
    process.exit(1);
  }

  const passwordHash = await hash(password);
  const existing = await unsafePrismaAdmin.appUser.findUnique({
    where: { email },
    select: { id: true },
  });

  // F-03: audit the mint. actor_user_id is NULL because this runs from an
  // operator's laptop with no signed-in caller (bootstrap by definition).
  // Meta captures the OS user + hostname so future forensics can trace
  // the operator context.
  const os = await import('node:os');
  const meta = {
    via: 'scripts/create-platform-user.ts',
    invokedBy: process.env.USER ?? os.userInfo().username ?? '<unknown>',
    hostname: os.hostname(),
    roleKey,
  };

  let userId: string;
  let action: 'platform_user.create' | 'platform_user.update';
  if (existing) {
    await unsafePrismaAdmin.appUser.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        platformRoleId: role.id,
        mfaEnabled: true,
        status: 'active',
        sessionVersion: { increment: 1 },
      },
    });
    userId = existing.id;
    action = 'platform_user.update';
    console.log(`✔ updated ${email} → ${roleKey} (sessionVersion bumped)`);
  } else {
    const created = await unsafePrismaAdmin.appUser.create({
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
    userId = created.id;
    action = 'platform_user.create';
    console.log(`✔ created ${email} → ${roleKey} (id=${created.id})`);
  }

  // Append-only audit row. Failure here is logged but does NOT roll back
  // the user write — the account already exists in the DB, losing the
  // audit row is worse than a partial mint but not worth reverting.
  try {
    await unsafePrismaAdmin.auditLog.create({
      data: {
        organizationId: null, // platform-scoped event
        actorUserId: null, // no signed-in caller — bootstrap
        action,
        entity: 'staff',
        entityId: userId,
        meta,
      },
    });
  } catch (err) {
    console.error(`WARN: audit_log insert failed: ${(err as Error).message}`);
    console.error('The account was created/updated successfully; only the audit row is missing.');
  }

  await unsafePrismaAdmin.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
