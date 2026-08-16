import { describe, it, expect, vi } from 'vitest';
import {
  scrubPhi,
  sentryBeforeSend,
  withRequestContext,
  log,
  sanitizeErrorMessage,
} from '@/lib/logger';

// -----------------------------------------------------------------------------
// scrubPhi behavior — narrow, exact-key match (SEC-007 followup).
//
// The pattern is deliberately narrow so operational keys like `serviceName`,
// `organizationName`, `providerName`, `hostname` stay visible in log lines
// (the old broad /name/i pattern stripped every one of them, killing
// triage). Any new client-PII key added to the codebase MUST be added to
// PHI_KEY_NAMES in lib/logger.ts — the scrubber will only catch what it
// knows to look for.
// -----------------------------------------------------------------------------
describe('logger.scrubPhi — narrow exact-key match', () => {
  it('redacts exact client-PII key names', () => {
    const scrubbed = scrubPhi({
      email: 'patient@example.com',
      phone: '+995551234567',
      dob: '1990-01-01',
      address: '1 Main St',
      customerName: 'Sarah Patient',
      patientName: 'Sarah Patient',
      clientName: 'Sarah Client',
      fullName: 'Sarah Patient Ivanova',
      allergies: 'penicillin',
      clinicalNotes: 'diagnosis details',
    });
    // Every one of these keys should be redacted.
    for (const [k, v] of Object.entries(scrubbed as Record<string, unknown>)) {
      expect(v, `key ${k} should be redacted`).toBe('[redacted]');
    }
  });

  it('redacts snake_case variants', () => {
    const scrubbed = scrubPhi({
      customer_name: 'x',
      patient_name: 'x',
      client_name: 'x',
      full_name: 'x',
      clinical_notes: 'x',
      password_hash: 'x',
    }) as Record<string, unknown>;
    expect(scrubbed.customer_name).toBe('[redacted]');
    expect(scrubbed.patient_name).toBe('[redacted]');
    expect(scrubbed.client_name).toBe('[redacted]');
    expect(scrubbed.full_name).toBe('[redacted]');
    expect(scrubbed.clinical_notes).toBe('[redacted]');
    expect(scrubbed.password_hash).toBe('[redacted]');
  });

  it('redacts auth secrets', () => {
    const scrubbed = scrubPhi({
      password: 'p',
      passwordHash: 'h',
      token: 't',
      refreshToken: 'r',
      accessToken: 'a',
      apiKey: 'k',
      authSecret: 's',
    }) as Record<string, unknown>;
    for (const [k, v] of Object.entries(scrubbed)) {
      expect(v, `secret key ${k} must be redacted`).toBe('[redacted]');
    }
  });

  it('redacts keys regardless of case (Email, PASSWORD, MfaTotp, RECOVERY_CODE)', () => {
    const scrubbed = scrubPhi({
      Email: 'patient@example.com',
      PASSWORD: 'secret123',
      MfaTotp: 'encrypted-totp-secret',
      RECOVERY_CODE: 'ABCDE-FGHIJ-KLMNO-PQRST',
      IpAddress: '203.0.113.42',
    }) as Record<string, unknown>;
    expect(scrubbed.Email).toBe('[redacted]');
    expect(scrubbed.PASSWORD).toBe('[redacted]');
    expect(scrubbed.MfaTotp).toBe('[redacted]');
    expect(scrubbed.RECOVERY_CODE).toBe('[redacted]');
    expect(scrubbed.IpAddress).toBe('[redacted]');
  });

  it('does NOT redact operational *Name keys (serviceName, organizationName, etc.)', () => {
    const scrubbed = scrubPhi({
      serviceName: 'Deep Clean',
      organizationName: 'Grand Medical',
      providerName: 'twilio',
      staffName: 'Dr. Ivanova',
      roleName: 'ORG_OWNER',
      hostname: 'db.example.com',
      pluginName: 'stripe',
      pathName: '/api/foo',
    }) as Record<string, unknown>;
    // Every one must pass through unchanged — the old broad regex would
    // have stripped them all. This is the SEC-007 followup fix.
    expect(scrubbed.serviceName).toBe('Deep Clean');
    expect(scrubbed.organizationName).toBe('Grand Medical');
    expect(scrubbed.providerName).toBe('twilio');
    expect(scrubbed.staffName).toBe('Dr. Ivanova');
    expect(scrubbed.roleName).toBe('ORG_OWNER');
    expect(scrubbed.hostname).toBe('db.example.com');
    expect(scrubbed.pluginName).toBe('stripe');
    expect(scrubbed.pathName).toBe('/api/foo');
  });

  it('recurses into nested objects and arrays', () => {
    const scrubbed = scrubPhi({
      items: [
        { customerName: 'a', ok: true },
        { customerName: 'b', ok: false },
      ],
      wrapped: { deep: { email: 'a@b.c' } },
    }) as {
      items: Array<{ customerName: string; ok: boolean }>;
      wrapped: { deep: { email: string } };
    };
    expect(scrubbed.items[0].customerName).toBe('[redacted]');
    expect(scrubbed.items[1].ok).toBe(false);
    expect(scrubbed.wrapped.deep.email).toBe('[redacted]');
  });

  it('leaves primitives untouched', () => {
    expect(scrubPhi(42)).toBe(42);
    expect(scrubPhi('plain')).toBe('plain');
    expect(scrubPhi(null)).toBe(null);
    expect(scrubPhi(undefined)).toBe(undefined);
  });

  it('KNOWN LIMITATION: value-level PII inside err.message is NOT scrubbed', () => {
    // Documented open item — see docs/rbac-status.md. A phone number
    // substring inside an arbitrary `err.message` string passes through
    // because the key ('message') is not on PHI_KEY_NAMES. Value-level
    // scrubbing is deferred; the fix belongs at the error boundary
    // (mapError in lib/auth.ts), not in the logger.
    const scrubbed = scrubPhi({
      error: 'sms send failed to +995551234567',
      message: 'contact patient@example.com',
    }) as Record<string, unknown>;
    // Currently passes through — this test locks in the known limitation.
    // If a future change adds value-level scrubbing, update this test.
    expect(scrubbed.error).toBe('sms send failed to +995551234567');
    expect(scrubbed.message).toBe('contact patient@example.com');
  });
});

// -----------------------------------------------------------------------------
// emit() integration — scrubPhi is now the primary guard, wired into every
// log.info / log.warn / log.error / log.debug call.
// -----------------------------------------------------------------------------
describe('log.* emits — scrubbed line reaches stdout/stderr', () => {
  it('scrubs a PII field before writing the JSON line', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    try {
      log.info('probe', { email: 'patient@example.com', orgId: 'org-x', serviceName: 'Cleaning' });
    } finally {
      spy.mockRestore();
    }

    const line = JSON.parse(lines[0]);
    expect(line.email).toBe('[redacted]');
    // Non-PII passes through.
    expect(line.orgId).toBe('org-x');
    expect(line.serviceName).toBe('Cleaning');
    expect(line.msg).toBe('probe');
    expect(line.level).toBe('info');
  });

  it('warn/error go to stderr and are scrubbed', () => {
    const errLines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((s: unknown) => {
      errLines.push(String(s));
    });
    try {
      log.warn('probe.warn', { patientName: 'Sarah', code: 'X' });
      log.error('probe.err', { fullName: 'Sarah I', latencyMs: 12 });
    } finally {
      spy.mockRestore();
    }

    const w = JSON.parse(errLines[0]);
    const e = JSON.parse(errLines[1]);
    expect(w.patientName).toBe('[redacted]');
    expect(w.code).toBe('X');
    expect(e.fullName).toBe('[redacted]');
    expect(e.latencyMs).toBe(12);
  });

  it('preserves request context (orgId, requestId, actorUserId)', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    try {
      withRequestContext({ requestId: 'req-a', orgId: 'org-b', actorUserId: 'user-c' }, () =>
        log.info('ctx.check', { serviceName: 'Consult' }),
      );
    } finally {
      spy.mockRestore();
    }

    const line = JSON.parse(lines[0]);
    expect(line.requestId).toBe('req-a');
    expect(line.orgId).toBe('org-b');
    expect(line.actorUserId).toBe('user-c');
    expect(line.serviceName).toBe('Consult');
  });

  it('regression guard: a fully-PII payload MUST NOT surface any value to the log line', () => {
    // If someone adds a new client-PII key to the codebase, this test
    // won't catch it — the developer must also add the key to
    // PHI_KEY_NAMES. But for every KNOWN key, this test proves the
    // scrubber runs at emit boundary.
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    try {
      log.info('all.pii', {
        email: 'patient@example.com',
        phone: '+995551234567',
        dob: '1990-01-01',
        address: '1 Main St',
        customerName: 'A',
        patientName: 'B',
        clientName: 'C',
        fullName: 'D',
        allergies: 'E',
        clinicalNotes: 'F',
        password: 'p',
        passwordHash: 'h',
        token: 't',
      });
    } finally {
      spy.mockRestore();
    }

    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    // Regression: none of the PII values survive.
    for (const k of [
      'email',
      'phone',
      'dob',
      'address',
      'customerName',
      'patientName',
      'clientName',
      'fullName',
      'allergies',
      'clinicalNotes',
      'password',
      'passwordHash',
      'token',
    ]) {
      expect(line[k], `${k} leaked`).toBe('[redacted]');
    }
  });
});

// -----------------------------------------------------------------------------
// sentryBeforeSend — same scrub, still adds request-context tags.
// -----------------------------------------------------------------------------
describe('sentryBeforeSend', () => {
  it('scrubs PHI and adds orgId/requestId tags from the request context', () => {
    const event = { message: 'oops', tags: { env: 'prod' }, extra: { email: 'e@x.com' } };
    const out = withRequestContext({ requestId: 'req-1', orgId: 'org-42' }, () =>
      sentryBeforeSend(event),
    ) as { tags: Record<string, string>; extra: { email: string } };
    expect(out.tags.orgId).toBe('org-42');
    expect(out.tags.requestId).toBe('req-1');
    expect(out.tags.env).toBe('prod');
    expect(out.extra.email).toBe('[redacted]');
  });
});

// -----------------------------------------------------------------------------
// sanitizeErrorMessage — F4 regression tests (value-level PII in err.message).
//
// Strips patterns that routinely appear in third-party error strings before
// the message reaches a log call. Each test below corresponds to a specific
// incident vector:
//   - PostgreSQL DETAIL clauses expose the email/phone value that caused a
//     unique-constraint violation ("Key (email)=(user@host) already exists").
//   - SMS providers (SMS Office, Twilio) echo the destination number in
//     delivery-failure messages.
//   - Email providers (Postmark, Resend) echo the To address.
//   - pg/Prisma connection errors expose the DATABASE_URL credential string.
// -----------------------------------------------------------------------------
describe('sanitizeErrorMessage — F4 PII-in-error-message scrubbing', () => {
  it('strips PostgreSQL DETAIL clause', () => {
    const msg = sanitizeErrorMessage(
      new Error(
        'duplicate key value violates unique constraint "app_users_email_key"\nDETAIL: Key (email)=(patient@example.com) already exists.',
      ),
    );
    expect(msg).not.toContain('patient@example.com');
    expect(msg).toContain('DETAIL: [redacted]');
  });

  it('strips E.164 phone numbers', () => {
    const msg = sanitizeErrorMessage(new Error('SMS failed: could not deliver to +995551234567'));
    expect(msg).not.toContain('+995551234567');
    expect(msg).toContain('[phone]');
  });

  it('strips email addresses from error messages', () => {
    const msg = sanitizeErrorMessage(
      new Error('Postmark error: recipient admin@clinic.ge bounced'),
    );
    expect(msg).not.toContain('admin@clinic.ge');
    expect(msg).toContain('[email]');
  });

  it('strips connection strings', () => {
    const msg = sanitizeErrorMessage(
      new Error('connect ECONNREFUSED postgresql://bookpitch_app:s3cr3t@db.host/main'),
    );
    expect(msg).not.toContain('s3cr3t');
    expect(msg).toContain('postgresql://[connection-string]');
  });

  it('handles non-Error values', () => {
    expect(sanitizeErrorMessage('raw string with user@host.com')).toContain('[email]');
    expect(sanitizeErrorMessage(42)).toBe('42');
    expect(sanitizeErrorMessage(null)).toBe('null');
  });

  it('complement: benign messages pass through unchanged', () => {
    const raw = 'connection timeout after 5000ms';
    expect(sanitizeErrorMessage(new Error(raw))).toBe(raw);
  });
});
