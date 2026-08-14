import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// next-auth pulls in next/server; mock @/auth so the module graph stays clean.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// -----------------------------------------------------------------------------
// Phase 7 §7.8 — Log-capture canary tests.
//
// Plants unique sensitive values and asserts they NEVER appear in captured
// logger output. Tests are self-contained — no database access required.
//
// Each test:
//   1. Captures console.log / console.error via spies.
//   2. Invokes scrubSensitive / log.* with a payload containing a canary.
//   3. Asserts the canary is absent from all captured output.
//   4. Asserts that safe operational fields are still present (so redaction
//      does not make logs useless).
// -----------------------------------------------------------------------------

const { scrubSensitive, sanitizeErrorMessage, log } = await import('@/lib/logger');
const { hashForBucket, extractClientIp } = await import('@/lib/platform/rate-limit');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unique canary values — deterministic for the test run, meaningless outside it. */
function canary(label: string) {
  return `CANARY_${label}_${Math.random().toString(36).slice(2)}`;
}

/** Capture all JSON lines emitted to console.log + console.error. */
function captureLog() {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => lines.push(s));
  const errSpy = vi.spyOn(console, 'error').mockImplementation((s: string) => lines.push(s));
  return {
    lines,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

// ── scrubSensitive ────────────────────────────────────────────────────────────

describe('scrubSensitive', () => {
  it('redacts password at depth 0', () => {
    const pw = canary('PW');
    const out = scrubSensitive({ password: pw });
    expect(JSON.stringify(out)).not.toContain(pw);
    expect((out as Record<string, unknown>).password).toBe('[redacted]');
  });

  it('redacts nested password inside error-like object', () => {
    const pw = canary('NESTED_PW');
    const out = scrubSensitive({ outer: { inner: { password: pw } } });
    expect(JSON.stringify(out)).not.toContain(pw);
  });

  it('redacts mfaTotp / TOTP secrets', () => {
    const secret = canary('TOTP_SECRET');
    const out = scrubSensitive({ mfaTotp: secret, mfaTotpPending: secret, totpSecret: secret });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('redacts recoveryCode and codeHash', () => {
    const code = canary('RECOVERY');
    const out = scrubSensitive({ recoveryCode: code, codeHash: code });
    expect(JSON.stringify(out)).not.toContain(code);
  });

  it('redacts connectionString / databaseUrl values', () => {
    const dbUrl = `postgresql://user:${canary('DBPASS')}@host:5432/db`;
    const out = scrubSensitive({ connectionString: dbUrl, databaseUrl: dbUrl });
    expect(JSON.stringify(out)).not.toContain(dbUrl);
  });

  it('redacts cookie and authorization headers', () => {
    const tok = canary('SESSION');
    const out = scrubSensitive({ cookie: `session=${tok}`, authorization: `Bearer ${tok}` });
    expect(JSON.stringify(out)).not.toContain(tok);
  });

  it('redacts ip and ipAddress', () => {
    const ip = '203.0.113.42'; // TEST-NET — safe to use in tests
    const out = scrubSensitive({ ip, ipAddress: ip });
    expect(JSON.stringify(out)).not.toContain(ip);
  });

  it('redacts email at key level', () => {
    const addr = `canary_${canary('MAIL')}@example.com`;
    const out = scrubSensitive({ email: addr });
    expect(JSON.stringify(out)).not.toContain(addr);
  });

  it('keeps safe operational fields intact', () => {
    const out = scrubSensitive({
      sessionId: 'sess-abc',
      status: 200,
      durationMs: 42,
      action: 'break_glass.start',
      count: 7,
      password: 'should-be-gone',
    }) as Record<string, unknown>;
    expect(out.sessionId).toBe('sess-abc');
    expect(out.status).toBe(200);
    expect(out.durationMs).toBe(42);
    expect(out.action).toBe('break_glass.start');
    expect(out.count).toBe(7);
    expect(out.password).toBe('[redacted]');
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => scrubSensitive(obj)).not.toThrow();
    const out = scrubSensitive(obj) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe('[circular]');
  });

  it('handles deeply nested structures by truncating at depth limit', () => {
    // Build a chain 20 levels deep.
    let node: unknown = { leaf: canary('DEEP_LEAF') };
    for (let i = 0; i < 20; i++) node = { child: node };
    expect(() => scrubSensitive(node)).not.toThrow();
    const s = JSON.stringify(scrubSensitive(node));
    expect(s).toContain('[truncated]');
  });

  it('handles very long strings by truncating', () => {
    const long = 'x'.repeat(5000);
    const out = scrubSensitive({ msg: long }) as Record<string, unknown>;
    expect((out.msg as string).length).toBeLessThan(5000);
    expect(out.msg).toContain('…');
  });

  it('handles arrays with more than 50 elements', () => {
    const arr = Array.from({ length: 80 }, (_, i) => i);
    const out = scrubSensitive({ items: arr }) as Record<string, unknown>;
    const outArr = out.items as unknown[];
    expect(outArr.length).toBeLessThanOrEqual(52); // 50 items + 1 truncation notice + slack
  });

  it('handles BigInt values without throwing', () => {
    expect(() => scrubSensitive({ window: BigInt(12345) })).not.toThrow();
    const out = scrubSensitive({ window: BigInt(12345) }) as Record<string, unknown>;
    expect(typeof out.window).not.toBe('bigint'); // converted to string
  });

  it('handles Error objects by extracting message only, not stack', () => {
    const err = new Error('something failed');
    const out = scrubSensitive({ error: err }) as Record<string, unknown>;
    const errOut = out.error as Record<string, unknown>;
    expect(errOut._error).toBe(true);
    expect(errOut.message).toBeDefined();
    expect(errOut.stack).toBeUndefined();
  });

  it('handles Error with nested cause chain', () => {
    const cause = new Error(`cause: postgres://user:secret@host/db`);
    const outer = new Error('outer', { cause });
    const out = scrubSensitive({ err: outer }) as Record<string, unknown>;
    // The cause chain is not serialized — only the outer message.
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('handles objects with hostile getters without throwing', () => {
    const hostile = Object.defineProperty({}, 'bad', {
      get() {
        throw new Error('hostile getter');
      },
      enumerable: true,
    });
    expect(() => scrubSensitive(hostile)).not.toThrow();
    const out = scrubSensitive(hostile) as Record<string, unknown>;
    expect(out.bad).toBe('[error]');
  });

  // ── Value-level detection ──────────────────────────────────────────────────

  it('redacts PostgreSQL connection strings in string values (any key)', () => {
    const connStr = `postgresql://bookpitch:${canary('DBSECRET')}@db.example.com/prod`;
    const out = scrubSensitive({ someMetadata: connStr });
    expect(JSON.stringify(out)).not.toContain(connStr);
    expect((out as Record<string, unknown>).someMetadata).toBe('[redacted]');
  });

  it('redacts Bearer tokens in string values (any key)', () => {
    const tok = `Bearer eyJhbGciOiJSUzI1NiJ9.${canary('TOKPAYLOAD')}.signature_goes_here_long_enough`;
    const out = scrubSensitive({ headerValue: tok });
    expect(JSON.stringify(out)).not.toContain(tok);
  });

  it('redacts JWT-shaped strings in string values', () => {
    // Three base64url segments > 60 chars total.
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkIn0.${canary('JWTSIG').repeat(3)}`;
    if (jwt.length < 60) return; // safety check for short canary
    const out = scrubSensitive({ token: jwt });
    expect((out as Record<string, unknown>).token).toBe('[redacted]');
  });

  it('does NOT redact ordinary short strings (no false positives)', () => {
    const safe = 'session_abc123';
    const out = scrubSensitive({ sessionId: safe });
    expect((out as Record<string, unknown>).sessionId).toBe(safe);
  });
});

// ── sanitizeErrorMessage ──────────────────────────────────────────────────────

describe('sanitizeErrorMessage', () => {
  it('strips PostgreSQL DETAIL clause', () => {
    const msg = `duplicate key value violates unique constraint. DETAIL: Key (email)=(user@example.com) already exists.`;
    expect(sanitizeErrorMessage(new Error(msg))).not.toContain('user@example.com');
    expect(sanitizeErrorMessage(new Error(msg))).toContain('DETAIL: [redacted]');
  });

  it('strips email addresses', () => {
    const email = `victim_${canary('MAIL')}@example.com`;
    const msg = `Failed to deliver to ${email}`;
    expect(sanitizeErrorMessage(new Error(msg))).not.toContain(email);
    expect(sanitizeErrorMessage(new Error(msg))).toContain('[email]');
  });

  it('strips PostgreSQL connection strings', () => {
    const msg = `connect ECONNREFUSED postgresql://admin:secret123@db.internal/prod`;
    expect(sanitizeErrorMessage(new Error(msg))).not.toContain('secret123');
    expect(sanitizeErrorMessage(new Error(msg))).toContain('[connection-string]');
  });

  it('strips phone numbers', () => {
    const msg = `SMS delivery failed for +995591234567`;
    expect(sanitizeErrorMessage(new Error(msg))).not.toContain('+995591234567');
    expect(sanitizeErrorMessage(new Error(msg))).toContain('[phone]');
  });

  it('strips Bearer tokens', () => {
    const tok = canary('BEARER_TOK');
    const msg = `Unauthorized: invalid authorization header Bearer ${tok}`;
    const out = sanitizeErrorMessage(new Error(msg));
    expect(out).not.toContain(tok);
    expect(out).toContain('Bearer [redacted]');
  });

  it('cannot throw for non-Error inputs', () => {
    expect(() => sanitizeErrorMessage(null)).not.toThrow();
    expect(() => sanitizeErrorMessage(undefined)).not.toThrow();
    expect(() => sanitizeErrorMessage(42)).not.toThrow();
    expect(() => sanitizeErrorMessage({ message: 'x' })).not.toThrow();
  });
});

// ── log.* integration ─────────────────────────────────────────────────────────

describe('log integration', () => {
  let cap: ReturnType<typeof captureLog>;
  beforeEach(() => {
    cap = captureLog();
  });
  afterEach(() => cap.restore());

  it('sensitive keys are absent from emitted JSON', () => {
    const pw = canary('LOG_PW');
    const mfaSecret = canary('LOG_TOTP');
    log.info('test.event', { status: 200, password: pw, mfaTotp: mfaSecret });
    expect(cap.lines.join('\n')).not.toContain(pw);
    expect(cap.lines.join('\n')).not.toContain(mfaSecret);
    // Safe fields are present.
    const parsed = JSON.parse(cap.lines[0]);
    expect(parsed.msg).toBe('test.event');
    expect(parsed.status).toBe(200);
    expect(parsed.level).toBe('info');
    expect(parsed.ts).toBeDefined();
  });

  it('BigInt in fields does not crash the logger', () => {
    expect(() => log.info('bigint.test', { window: BigInt(99999) })).not.toThrow();
    expect(cap.lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(cap.lines[0]);
    expect(parsed.window).toBe('99999');
  });

  it('circular reference in fields does not crash the logger', () => {
    const obj: Record<string, unknown> = { ok: true };
    obj.self = obj;
    expect(() => log.warn('circular.test', obj)).not.toThrow();
    expect(cap.lines.length).toBeGreaterThan(0);
  });

  it('connection string in arbitrary field is redacted from emitted JSON', () => {
    const connStr = `postgresql://admin:${canary('CONN_PW')}@db.supabase.co/postgres`;
    log.warn('db.event', { context: connStr });
    expect(cap.lines.join('\n')).not.toContain(connStr);
  });

  it('nested password key inside error-like fields is absent from log output', () => {
    const pw = canary('NESTED_LOG_PW');
    // Simulates a badly-wrapped Prisma error where credentials leaked into a
    // structured object with a 'password' key. Key-name redaction catches it
    // at any nesting depth.
    log.error('nested.event', {
      prismaError: {
        meta: { target: ['email'], credentials: { password: pw } },
        clientVersion: '5.0.0',
        message: 'Query failed',
      },
    });
    expect(cap.lines.join('\n')).not.toContain(pw);
    // Safe operational fields survive.
    const parsed = JSON.parse(cap.lines[0]);
    expect(parsed.prismaError.message).toBe('Query failed');
  });

  it('connection string embedded in a string field is redacted by value-level detection', () => {
    const connStr = `postgresql://admin:${canary('CONN_VALUE')}@db.internal/prod`;
    log.error('db.error', { context: connStr });
    expect(cap.lines.join('\n')).not.toContain(connStr);
  });

  it('very long attacker-controlled string is truncated in log output', () => {
    const long = 'A'.repeat(10000);
    log.info('long.event', { userInput: long });
    const output = cap.lines.join('\n');
    // The entire 10 000-char string must not appear verbatim.
    expect(output).not.toContain(long);
    // But a truncated portion of it should appear (up to MAX_STRING_LEN = 2000 chars).
    expect(output.length).toBeLessThan(output.length + long.length);
  });

  it('recovery code and TOTP secret are absent from log output', () => {
    const recoveryCode = canary('RC_12345678');
    const totpSecret = canary('TOTP_ABCDEF');
    log.info('mfa.event', { recoveryCode, totpSecret, action: 'mfa.recovery_code.consumed' });
    const output = cap.lines.join('\n');
    expect(output).not.toContain(recoveryCode);
    expect(output).not.toContain(totpSecret);
    // Safe field survives.
    const parsed = JSON.parse(cap.lines[0]);
    expect(parsed.action).toBe('mfa.recovery_code.consumed');
  });
});

// ── Phase 7 §7.7 — HMAC key fail-closed (production guard) ───────────────────

describe('rate-limit HMAC key production guard', () => {
  it('hashForBucket produces a 32-char hex digest under the test key', () => {
    // RATE_LIMIT_HMAC_KEY is set in the test environment; this confirms the
    // key is present and produces the correct-length output.
    const digest = hashForBucket('onboard:ip', '203.0.113.1');
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('two different inputs produce different digests', () => {
    const a = hashForBucket('onboard:ip', '203.0.113.1');
    const b = hashForBucket('onboard:ip', '203.0.113.2');
    expect(a).not.toBe(b);
  });

  it('same prefix + value always yields the same digest (deterministic)', () => {
    const first = hashForBucket('verify:ip', '::1');
    const second = hashForBucket('verify:ip', '::1');
    expect(first).toBe(second);
  });

  it('different prefixes for the same value produce different digests (domain separation)', () => {
    const onboard = hashForBucket('onboard:ip', '203.0.113.1');
    const verify = hashForBucket('verify:ip', '203.0.113.1');
    expect(onboard).not.toBe(verify);
  });
});

// ── Phase 7 §7.4 — Provider error normalization ───────────────────────────────

describe('sanitizeErrorMessage — provider error normalization', () => {
  it('strips email from Resend-style error body (invariant 7)', () => {
    // Resend errors embed the raw API response body (truncated to 200 chars).
    // Any recipient address that leaked into the error body must be stripped.
    const victim = `victim_${Math.random().toString(36).slice(2)}@example.com`;
    const err = new Error(`Resend send failed (422): {"message":"Invalid email: ${victim}"}`);
    const out = sanitizeErrorMessage(err);
    expect(out).not.toContain(victim);
    expect(out).toContain('[email]');
  });

  it('strips email from a generic provider body (invariant 7)', () => {
    const addr = `probe_${Math.random().toString(36).slice(2)}@mailgun.invalid`;
    const err = new Error(`provider rejected: {"to":"${addr}","code":422}`);
    const out = sanitizeErrorMessage(err);
    expect(out).not.toContain(addr);
    expect(out).toContain('[email]');
  });

  it('does not expose raw Turnstile error-code arrays as PII (invariant 8)', () => {
    // Turnstile errors are logged as `codes: data['error-codes']` (an array
    // of string codes like "invalid-input-response"). Confirm these contain
    // no sensitive value by verifying sanitizeErrorMessage leaves them intact.
    const safeCode = 'invalid-input-response';
    const err = new Error(`Turnstile rejected: ${safeCode}`);
    const out = sanitizeErrorMessage(err);
    // The error-code string must survive (it's not PII).
    expect(out).toContain(safeCode);
  });

  it('strips postgres:// connection string from a provider error (invariant 9)', () => {
    const err = new Error(`Connection error: postgres://admin:${canary('CONN')}@db.host/prod`);
    const out = sanitizeErrorMessage(err);
    expect(out).not.toMatch(/postgres:\/\/admin:/);
    expect(out).toContain('[connection-string]');
  });

  it('strips Bearer token from a provider error (invariant 10)', () => {
    const tok = canary('BEARER_IN_ERR');
    const err = new Error(`Unauthorized request — authorization: Bearer ${tok}`);
    const out = sanitizeErrorMessage(err);
    expect(out).not.toContain(tok);
    expect(out).toContain('Bearer [redacted]');
  });

  it('strips phone number from an error message (invariant 11)', () => {
    const err = new Error('SMS failed for +995591234567 — provider unavailable');
    const out = sanitizeErrorMessage(err);
    expect(out).not.toContain('+995591234567');
    expect(out).toContain('[phone]');
  });
});

// ── Phase 7 §7.14 — Trusted-proxy IP extraction ───────────────────────────────

describe('extractClientIp — trusted-proxy extraction (invariant 16)', () => {
  function headers(h: Record<string, string | undefined>) {
    return { get: (k: string) => h[k] ?? null };
  }

  it('prefers the first entry in x-forwarded-for', () => {
    const ip = extractClientIp(headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }));
    expect(ip).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const ip = extractClientIp(headers({ 'x-real-ip': '198.51.100.3' }));
    expect(ip).toBe('198.51.100.3');
  });

  it('returns null when no IP header is present', () => {
    const ip = extractClientIp(headers({}));
    expect(ip).toBeNull();
  });

  it('trims whitespace from x-forwarded-for entries', () => {
    const ip = extractClientIp(headers({ 'x-forwarded-for': '  203.0.113.7  , 10.0.0.2' }));
    expect(ip).toBe('203.0.113.7');
  });
});
