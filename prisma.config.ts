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
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
