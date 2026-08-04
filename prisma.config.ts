import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Load .env.local first (matches Next.js precedence), then .env as fallback.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Migrations must run as a role that can CREATE EXTENSION, DDL, etc.
    // The application connects as a non-superuser (bookpitch_app) so RLS
    // actually applies — see prisma/migrations/*_create_app_role.
    //
    // Precedence (SEC-007 rename + F-06 workflow compat):
    //   1. DATABASE_URL_SUPERUSER_MIGRATE — GH Actions preferred name
    //   2. DATABASE_URL_SUPERUSER_SESSION — new SEC-007 name (session-pool superuser)
    //   3. ADMIN_DATABASE_URL              — legacy name (still works)
    //   4. DIRECT_URL                       — legacy unpooled name
    //   5. DATABASE_URL                     — last-resort fallback so the
    //                                          F-06 workflow (which sets only
    //                                          DATABASE_URL from the secret)
    //                                          actually reaches Prisma. Local
    //                                          dev via DATABASE_URL alone
    //                                          works when that URL points at
    //                                          a role with DDL grants.
    url: process.env.DATABASE_URL_SUPERUSER_MIGRATE
      ?? process.env.DATABASE_URL_SUPERUSER_SESSION
      ?? process.env.ADMIN_DATABASE_URL
      ?? process.env.DIRECT_URL
      ?? process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
