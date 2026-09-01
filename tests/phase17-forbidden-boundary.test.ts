import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { perm } from '@/lib/rbac/types';
import type { AuthContext, PermissionKey } from '@/lib/rbac/types';

// lib/rbac/guard.ts binds Auth.js's `auth()` at import time; mock it first, as
// tests/rbac.test.ts does, so the barrel does not drag next-auth's runtime in.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { requirePagePermission } = await import('@/lib/rbac');
const { ForbiddenError } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// P17-013 — a denied page must be a 403 with an access-denied screen, not a 500.
//
// Measured before the fix, against `next start` at commit ceeb9a9 with the
// seeded MARKETING account:
//
//   /scheduler  500   /audit  500   /settings  500   /analytics  200
//
// and after:
//
//   /scheduler  403   /audit  403   /settings  403   /analytics  200
//
// The defect was never the refusal — `rbac.enforce_deny` fired every time and
// no tenant data rendered. It was that `app/(app)/error.tsx` dispatched on
// `error.name === 'ForbiddenError'`, and Next strips the name from errors
// forwarded to the client in a production build, so the "Access Locked" panel
// it was written for was unreachable in production. The user was told the
// server had broken.
//
// This file pins the three things that make the fix real, each with the
// complement that would have caught it silently regressing:
//
//   1. the guard converts a denial into Next's 403 interrupt, and does NOT
//      convert anything else;
//   2. the experimental flag that makes `forbidden()` work is enabled — without
//      it `forbidden()` throws a plain Error and the 500 comes straight back;
//   3. pages guard with the page form and route handlers do not, because a
//      route handler must keep answering 403 JSON.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

/** The digest Next uses to route a throw to the forbidden boundary. */
const FORBIDDEN_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;403';

function ctxWith(granted: string[]): AuthContext {
  return {
    userId: 'u1',
    email: 'u1@bp.test',
    membershipId: 'm1',
    activeOrganizationId: '00000000-0000-0000-0000-000000000001',
    roleKey: 'MARKETING',
    roleRank: 20,
    permissions: new Set(granted.map(perm)) as ReadonlySet<PermissionKey>,
    platformPermissions: new Set() as ReadonlySet<PermissionKey>,
    branchIds: new Set() as ReadonlySet<string>,
    impersonation: null,
    isImpersonating: false,
    breakGlass: null,
    isBreakGlass: false,
    sessionVersion: 1,
    authSessionId: 's1',
    organizationStatus: 'active',
    orgToggles: {
      providerFinancialReports: false,
      providerClinicalNotesOthers: false,
      frontdeskClientFullHistory: false,
      frontdeskDiscountCeiling: 0,
    },
  };
}

const ORG = '00000000-0000-0000-0000-000000000001';

describe('P17-013 the page guard emits Next authorization interrupts', () => {
  // `forbidden()` refuses to work unless the build set this. `next start` sets
  // it from experimental.authInterrupts; vitest is not a Next build, so the
  // test supplies it and restores whatever was there.
  const previous = process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS;
  beforeAll(() => {
    process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = '1';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS;
    else process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = previous;
  });

  it('a denial throws the 403 interrupt, not a ForbiddenError', () => {
    const ctx = ctxWith(['report.branch']); // MARKETING's real bundle: no booking.read
    let thrown: unknown;
    try {
      requirePagePermission(ctx, 'booking.read', { organizationId: ORG }, 'appointments');
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'the guard let a denied caller through').toBeDefined();
    expect((thrown as { digest?: string }).digest).toBe(FORBIDDEN_DIGEST);
    // The old shape must be gone: a ForbiddenError reaching the render is
    // exactly what produced the 500.
    expect(thrown).not.toBeInstanceOf(ForbiddenError);
  });

  it('COMPLEMENT: a permitted caller is returned the context and nothing is thrown', () => {
    const ctx = ctxWith(['report.branch']);
    expect(requirePagePermission(ctx, 'report.branch', { organizationId: ORG }, 'reports')).toBe(
      ctx,
    );
  });

  it('COMPLEMENT: a non-authorization failure keeps its own identity', () => {
    // A broken context is a server error and must reach the error boundary as
    // one. Mislabelling it a 403 would hide a real fault behind a denial page.
    const broken = null as unknown as AuthContext;
    expect(() => requirePagePermission(broken, 'booking.read', { organizationId: ORG })).toThrow(
      TypeError,
    );
  });

  it('COMPLEMENT: shadow mode still lets the caller through', () => {
    const previousModules = process.env.RBAC_ENFORCE_MODULES;
    process.env.RBAC_ENFORCE_MODULES = '';
    try {
      const ctx = ctxWith([]);
      // Shadow mode is a logging point, not a decision — the page must render.
      expect(
        requirePagePermission(ctx, 'booking.read', { organizationId: ORG }, 'appointments'),
      ).toBe(ctx);
    } finally {
      if (previousModules === undefined) delete process.env.RBAC_ENFORCE_MODULES;
      else process.env.RBAC_ENFORCE_MODULES = previousModules;
    }
  });
});

describe('P17-013 the configuration the interrupt depends on', () => {
  it('next.config.ts enables experimental.authInterrupts', () => {
    // Remove the flag and `forbidden()` throws E488 — an ordinary Error, which
    // Next answers with 500. That is the original defect, restored. Nothing
    // else in the test suite would notice, because the guard would still refuse.
    const cfg = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');
    expect(cfg).toMatch(/authInterrupts:\s*true/);
  });

  it('both forbidden boundaries exist', () => {
    for (const rel of ['app/(app)/forbidden.tsx', 'app/platform/forbidden.tsx']) {
      expect(existsSync(path.join(ROOT, rel)), `${rel} is missing`).toBe(true);
    }
  });

  it('the (app) boundary names the refusal and leaks no permission detail', () => {
    const src = readFileSync(path.join(ROOT, 'app/(app)/forbidden.tsx'), 'utf8');
    expect(src).toMatch(/Operational Access Lock/);
    // The panel is rendered to anyone who is refused; it must not name the
    // permission, the role rank, or whether the underlying record exists.
    expect(src).not.toMatch(/missing permission|roleKey|activeOrganizationId/);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('P17-013 the page/API split is real', () => {
  const appFiles = walk(path.join(ROOT, 'app'));

  it('no route handler uses the page guard — API denials stay JSON', () => {
    const offenders = appFiles
      .filter((f) => f.endsWith(path.join('route.ts')))
      .filter((f) => /\brequirePagePermission\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(
      offenders,
      'a route handler calling requirePagePermission would answer an HTML 403 page ' +
        'instead of the JSON body its callers parse',
    ).toEqual([]);
  });

  it('every guarded page and non-root layout uses the page guard', () => {
    const offenders = appFiles
      .filter((f) => /\/(page|layout)\.tsx$/.test(f))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /(?<![A-Za-z0-9_])requirePermission\s*\(/.test(src);
      })
      .map((f) => path.relative(ROOT, f))
      // app/platform/layout.tsx deliberately keeps requirePermission: it
      // catches ForbiddenError and redirects an org-plane caller to '/'. That
      // is a wrong-plane routing decision, not a denial the user can act on,
      // and e2e/journeys/forbidden-access.spec.ts pins the redirect.
      .filter((rel) => rel !== path.join('app', 'platform', 'layout.tsx'));
    expect(offenders, 'these render as pages, so a ForbiddenError from them becomes a 500').toEqual(
      [],
    );
  });

  it('COMPLEMENT: the scan actually sees the files it claims to scan', () => {
    const guarded = appFiles
      .filter((f) => /\/(page|layout)\.tsx$/.test(f))
      .filter((f) => /\brequirePagePermission\s*\(/.test(readFileSync(f, 'utf8')));
    // A scan that found nothing would pass both assertions above. 23 pages and
    // layouts were converted; require most of them to still be visible here so
    // a broken walk() cannot masquerade as a clean result.
    expect(guarded.length).toBeGreaterThanOrEqual(20);
  });
});
