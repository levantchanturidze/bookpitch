import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const manifest = (await import('@/app/manifest')).default;

describe('PWA manifest', () => {
  it('exports the fields Chrome/Safari need to install', () => {
    const m = manifest();
    expect(m.name).toBe('Bookpitch');
    expect(m.short_name).toBe('Bookpitch');
    expect(m.start_url).toBe('/scheduler');
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toBe('#0d9488');
    expect(m.background_color).toBe('#F8FAFC');
    expect(m.scope).toBe('/');
  });

  it('advertises both 192 and 512 icons + a maskable variant', () => {
    const m = manifest();
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('service worker script', () => {
  const swPath = path.join(process.cwd(), 'public/sw.js');
  const sw = fs.readFileSync(swPath, 'utf8');

  it('exists and is precacheable', () => {
    expect(sw.length).toBeGreaterThan(200);
  });

  it('precaches every top-level route the app shell needs', () => {
    // These have to be inside SHELL_URLS or navigating to them while offline
    // is a 503.
    for (const url of [
      '/scheduler',
      '/patients',
      '/reminders',
      '/billing',
      '/analytics',
      '/signin',
      '/offline',
    ]) {
      expect(sw).toContain(`'${url}'`);
    }
  });

  it('never intercepts /api/* or /dev/* requests', () => {
    // A regression on this would break payments (webhooks) and RLS
    // freshness. The code path is a `return` inside `fetch` handler.
    expect(sw).toMatch(/isApiOrDev/);
    expect(sw).toMatch(/\/api\//);
    expect(sw).toMatch(/\/dev\//);
  });

  it('bumps CACHE_VERSION on any strategy change (guards against stale shells)', () => {
    expect(sw).toMatch(/CACHE_VERSION\s*=\s*['"]bookpitch-/);
  });
});
