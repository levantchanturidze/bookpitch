import 'dotenv/config';
import { config as loadEnv } from 'dotenv';

// Vitest runs from the repo root; load .env.local like Next.js does.
loadEnv({ path: '.env.local', override: true });
