import 'dotenv/config';
import { config as loadEnv } from 'dotenv';

// Vitest runs from the repo root; load .env.local like Next.js does.
loadEnv({ path: '.env.local', override: true });

// Phase 4: tests always run in enforcing mode. The env var is set here
// (not in .env.local) so a developer can override it for a shadow-mode
// dry-run: `RBAC_ENFORCE_MODULES= npm test` disables enforcement.
if (!process.env.RBAC_ENFORCE_MODULES) {
  process.env.RBAC_ENFORCE_MODULES = '*';
}
