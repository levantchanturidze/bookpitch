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
    url: process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
