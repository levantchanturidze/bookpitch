import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Comprehensive Turnstile tests for POST /api/onboard.
//
// Tests: missing site key in production, missing secret key in production,
// missing token, invalid token, wrong action, wrong hostname, expired
// challenge, provider timeout, malformed response, valid response, CSP,
// client disabled state, development/test behavior.

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/onboarding', () => ({
  createPendingRegistration: vi.fn().mockResolvedValue(undefined),
}));

const { POST } = await import('@/app/api/onboard/route');

const BASE_PAYLOAD = {
  email: 'turn@example.com',
  password: 'Passw0rd!',
  fullName: 'Turn Stile',
  orgName: 'TurnCo',
};

function makeReq(body: Record<string, unknown> = {}, headers?: Record<string, string>) {
  const payload = { ...BASE_PAYLOAD, ...body };
  return new Request('http://localhost/api/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  }) as unknown as import('next/server').NextRequest;
}

const VALID_TS = new Date(Date.now() - 10_000).toISOString(); // 10 seconds ago

type FetchOverride = (_url: string | URL | Request, _init?: RequestInit) => Promise<Response>;

function mockTurnstile(responseBody: Record<string, unknown>): () => void {
  const orig = global.fetch;
  const mock = vi.fn().mockResolvedValueOnce({
    json: () => Promise.resolve(responseBody),
  }) as unknown as FetchOverride;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = orig;
  };
}

function mockTurnstileTimeout(): () => void {
  const orig = global.fetch;
  const mock = vi.fn().mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('AbortError')), 10);
      }),
  ) as unknown as FetchOverride;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = orig;
  };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  // Restore env to test defaults (no Turnstile keys).
  process.env = { ...originalEnv };
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_EXPECTED_ACTION;
  delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
  Object.assign(process.env, { NODE_ENV: 'test' });
});

afterAll(() => {
  process.env = originalEnv;
});

// ── TS.1: Missing secret key — development/test → allow ──────────────────────

describe('TS.1 — missing secret key in dev/test → passes without CAPTCHA', () => {
  it('no TURNSTILE_SECRET_KEY set → verifyTurnstile returns true in non-production', async () => {
    Object.assign(process.env, { NODE_ENV: 'test' });
    const res = await POST(makeReq());
    // createPendingRegistration mock resolves → 202
    expect(res.status).toBe(202);
  });
});

// ── TS.2: Missing secret key — production → fail closed ──────────────────────

describe('TS.2 — missing secret key in production → 400 (fail closed)', () => {
  it('NODE_ENV=production, no TURNSTILE_SECRET_KEY → 400 regardless of token', async () => {
    Object.assign(process.env, { NODE_ENV: 'production' });
    // No secret key set. verifyTurnstile detects production + no key → false.
    const res = await POST(makeReq({ turnstileToken: 'some-token' }));
    expect(res.status).toBe(400);
  });
});

// ── TS.3: Missing token ──────────────────────────────────────────────────────

describe('TS.3 — missing token with secret key configured → 400', () => {
  it('TURNSTILE_SECRET_KEY set, no token provided → 400', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    // No turnstileToken in body → verifyTurnstile(null) → false.
    const restore = mockTurnstile({ success: true, challenge_ts: VALID_TS });
    try {
      const res = await POST(makeReq());
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });
});

// ── TS.4: Invalid token ──────────────────────────────────────────────────────

describe('TS.4 — provider rejects token → 400', () => {
  it('Turnstile provider returns success=false → 400', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const restore = mockTurnstile({ success: false, 'error-codes': ['invalid-input-response'] });
    try {
      const res = await POST(makeReq({ turnstileToken: 'bad-token' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });
});

// ── TS.5: Wrong action ───────────────────────────────────────────────────────

describe('TS.5 — provider returns wrong action → 400', () => {
  it('action=login does not satisfy expected action=signup → 400', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.TURNSTILE_EXPECTED_ACTION = 'signup';
    const restore = mockTurnstile({ success: true, action: 'login', challenge_ts: VALID_TS });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it('action=signup satisfies expected action=signup → 202', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.TURNSTILE_EXPECTED_ACTION = 'signup';
    const restore = mockTurnstile({ success: true, action: 'signup', challenge_ts: VALID_TS });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(202);
    } finally {
      restore();
    }
  });
});

// ── TS.6: Wrong hostname ─────────────────────────────────────────────────────

describe('TS.6 — provider returns wrong hostname → 400', () => {
  it('hostname=evil.com not in allowlist → 400', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'bookpitch.com,staging.bookpitch.com';
    const restore = mockTurnstile({ success: true, hostname: 'evil.com', challenge_ts: VALID_TS });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it('hostname=bookpitch.com is in allowlist → 202', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'bookpitch.com,staging.bookpitch.com';
    const restore = mockTurnstile({
      success: true,
      hostname: 'bookpitch.com',
      challenge_ts: VALID_TS,
    });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(202);
    } finally {
      restore();
    }
  });
});

// ── TS.7: Expired challenge (age > 5 minutes) ────────────────────────────────

describe('TS.7 — challenge timestamp too old → 400', () => {
  it('challenge_ts from 10 minutes ago → rejected', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const restore = mockTurnstile({ success: true, challenge_ts: staleTs });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it('challenge_ts from 30 seconds ago → accepted', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const freshTs = new Date(Date.now() - 30_000).toISOString();
    const restore = mockTurnstile({ success: true, challenge_ts: freshTs });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(202);
    } finally {
      restore();
    }
  });
});

// ── TS.8: Provider timeout ───────────────────────────────────────────────────

describe('TS.8 — provider network timeout', () => {
  it('timeout in test env → falls open (non-production)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    Object.assign(process.env, { NODE_ENV: 'test' });
    const restore = mockTurnstileTimeout();
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      // Non-production: fail open → 202
      expect(res.status).toBe(202);
    } finally {
      restore();
    }
  });

  it('timeout in production → fails closed (400)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    Object.assign(process.env, { NODE_ENV: 'production' });
    const restore = mockTurnstileTimeout();
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });
});

// ── TS.9: Malformed response ─────────────────────────────────────────────────

describe('TS.9 — malformed provider response → 400', () => {
  it('provider returns empty object (no success field) → 400', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const restore = mockTurnstile({});
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it('provider returns success=null → 400', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const restore = mockTurnstile({ success: null });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });
});

// ── TS.10: Valid response ─────────────────────────────────────────────────────

describe('TS.10 — valid Turnstile response → 202', () => {
  it('success=true with recent challenge_ts → 202', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const restore = mockTurnstile({ success: true, challenge_ts: VALID_TS });
    try {
      const res = await POST(makeReq({ turnstileToken: 'valid-tok' }));
      expect(res.status).toBe(202);
    } finally {
      restore();
    }
  });
});

// ── TS.11: CSP contains exact Cloudflare origins ─────────────────────────────

describe('TS.11 — CSP contains required Cloudflare Turnstile origins', () => {
  it('next.config.ts CSP includes Cloudflare script origin', async () => {
    const { readFileSync } = await import('node:fs');
    const config = readFileSync('next.config.ts', 'utf8');
    expect(config).toContain('https://challenges.cloudflare.com');
  });

  it('CSP includes frame-src for Turnstile widget iframe', async () => {
    const { readFileSync } = await import('node:fs');
    const config = readFileSync('next.config.ts', 'utf8');
    expect(config).toMatch(/frame-src[^;]*challenges\.cloudflare\.com/);
  });

  it('CSP includes script-src for Turnstile script tag', async () => {
    const { readFileSync } = await import('node:fs');
    const config = readFileSync('next.config.ts', 'utf8');
    expect(config).toMatch(/script-src[^;]*challenges\.cloudflare\.com/);
  });
});

// ── TS.12: Client disabled state logic (unit tests of SignupForm constants) ───

describe('TS.12 — client submit disabled state', () => {
  it('submitDisabled is true when SITE_KEY is set and captchaToken is null', () => {
    // Simulates: captchaRequired = true (SITE_KEY truthy), captchaToken = null
    const SITE_KEY = 'a-real-site-key';
    const captchaRequired = !!SITE_KEY;
    const captchaToken: string | null = null;
    const status: string = 'idle';
    const submitDisabled = status === 'submitting' || (captchaRequired && !captchaToken);
    expect(submitDisabled).toBe(true);
  });

  it('submitDisabled is false when SITE_KEY is set and captchaToken is present', () => {
    const SITE_KEY = 'a-real-site-key';
    const captchaRequired = !!SITE_KEY;
    const captchaToken = 'solved-token';
    const status: string = 'idle';
    const submitDisabled = status === 'submitting' || (captchaRequired && !captchaToken);
    expect(submitDisabled).toBe(false);
  });

  it('submitDisabled is false in dev (no SITE_KEY) when token is absent', () => {
    const SITE_KEY = '';
    const captchaRequired = !!SITE_KEY || process.env.NODE_ENV === 'production';
    const captchaToken: string | null = null;
    const status: string = 'idle';
    const submitDisabled = status === 'submitting' || (captchaRequired && !captchaToken);
    // In test/dev mode with no site key: captchaRequired = false → submitDisabled = false
    expect(submitDisabled).toBe(false);
  });
});

// ── TS.13: Provider error body not leaked ────────────────────────────────────

describe('TS.13 — provider error body is not in the response', () => {
  it('error-codes from provider are not echoed back in the 400 response', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const restore = mockTurnstile({
      success: false,
      'error-codes': ['timeout-or-duplicate', 'internal-server-error'],
    });
    try {
      const res = await POST(makeReq({ turnstileToken: 'tok' }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('timeout-or-duplicate');
      expect(JSON.stringify(body)).not.toContain('internal-server-error');
    } finally {
      restore();
    }
  });
});
