import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { NAV_ITEMS } from '@/components/shell/nav-items';

// -----------------------------------------------------------------------------
// F16-003. The sidebar hides an entry the caller cannot use, and each page
// enforces its own requirePermission() at the route boundary. Those are two
// separate lists of permission keys that must agree.
//
// They do agree today — all eight pairs were checked by hand. Nothing enforced
// it, so a change to either side could drift silently, and the symptom would be
// either a visible link that 403s on click or a working page nobody can find.
//
// This is a structural guard, not a behavioural one: it proves the two sources
// name the same permission, not that the permission is enforced. Enforcement is
// covered by scripts/check-guards.ts and the route-access tests.
// -----------------------------------------------------------------------------

const APP_DIR = path.join(process.cwd(), 'app', '(app)');

/**
 * First permission key passed to a permission-guard call in `source`.
 *
 * Both forms count. P17-013 introduced `requirePagePermission`, which makes the
 * same decision as `requirePermission` and differs only in how it refuses — a
 * 403 page instead of a thrown ForbiddenError. Matching only the original name
 * made every converted page look unguarded, which is how this test failed the
 * rename: eight "has no requirePermission() call" failures for eight pages that
 * were guarded the whole time.
 */
function guardedPermissions(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/require(?:Page)?Permission\s*\(([\s\S]{0,400}?)\)\s*;/g)) {
    const first = match[1].match(/'([^']+)'/);
    if (first) out.push(first[1]);
  }
  return out;
}

/** Every permission guarded by any page/layout file directly under a nav route. */
function permissionsForRoute(routeDir: string): string[] {
  const dir = path.join(APP_DIR, routeDir);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.tsx') && !entry.endsWith('.ts')) continue;
    out.push(...guardedPermissions(readFileSync(path.join(dir, entry), 'utf8')));
  }
  return out;
}

describe('F16-003 · sidebar permissions match the guard on the page they link to', () => {
  it('covers every nav item (the table is not silently empty)', () => {
    expect(NAV_ITEMS.length).toBeGreaterThanOrEqual(8);
  });

  for (const item of NAV_ITEMS) {
    it(`${item.id} → ${item.href} enforces ${item.requiredPermission}`, () => {
      const routeDir = item.href.replace(/^\//, '');
      const guarded = permissionsForRoute(routeDir);

      // If this fails, the route stopped guarding entirely — a far worse
      // problem than a mismatch, and the reason the emptiness is asserted
      // separately from the comparison.
      expect(
        guarded.length,
        `${item.href} has no requirePermission()/requirePagePermission() call`,
      ).toBeGreaterThan(0);

      expect(
        guarded,
        `sidebar shows "${item.id}" for ${item.requiredPermission}, but ${item.href} guards ${guarded.join(', ')}`,
      ).toContain(item.requiredPermission);
    });
  }
});
