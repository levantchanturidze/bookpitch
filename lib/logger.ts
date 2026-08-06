import { AsyncLocalStorage } from 'node:async_hooks';

// -----------------------------------------------------------------------------
// Structured logger + request context (orgId, requestId, actorUserId).
//
// - AsyncLocalStorage carries the context across await boundaries so we don't
//   have to thread it through every function signature.
// - Every emitted line is one JSON object; downstream (Vercel, Datadog,
//   Sentry) all ingest this shape trivially.
// - PHI rule: NEVER call log() with a customer name, email, phone, DOB,
//   allergies, or clinical notes as a value. `scrubPhi` runs unconditionally
//   inside emit() so keys on PHI_KEY_NAMES get scrubbed to '[redacted]'
//   before the JSON line hits stdout — it IS the primary guard now.
//   Developer discipline is still the first layer; the scrubber is the
//   second. Value-level PII embedded inside string values (a phone number
//   spliced into an `err.message`) is not caught here — see
//   docs/rbac-status.md for that follow-up.
// -----------------------------------------------------------------------------

export type LogContext = {
  requestId: string;
  orgId?: string;
  actorUserId?: string;
  route?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function newRequestId(): string {
  // Web Crypto API — available on both Node 19+ and the Edge Runtime,
  // unlike `node:crypto` which the Edge Runtime rejects at build time.
  return globalThis.crypto.randomUUID();
}

export function withRequestContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): LogContext | undefined {
  return storage.getStore();
}

export function updateRequestContext(patch: Partial<LogContext>): void {
  const cur = storage.getStore();
  if (!cur) return;
  Object.assign(cur, patch);
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const ctx = storage.getStore();
  // scrubPhi is now the primary guard (not just a Sentry hook). Every
  // structured payload is scrubbed before the JSON line is emitted, so a
  // developer who logs `{ email: user.email }` doesn't leak PII to
  // stdout / Vercel logs / any downstream sink.
  const scrubbed = fields ? scrubPhi(fields) : undefined;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    requestId: ctx?.requestId,
    orgId: ctx?.orgId,
    actorUserId: ctx?.actorUserId,
    route: ctx?.route,
    ...(scrubbed ?? {}),
  };
  // Vercel + Datadog + Sentry-Log-drain all ingest a single JSON line.
  // console.error → stderr, console.log → stdout so the platform surfaces
  // warn/error separately. Uses `console.*` instead of `process.stdout` so
  // the same code runs on the Node and Edge runtimes.
  const s = JSON.stringify(line);
  if (level === 'warn' || level === 'error') {
    console.error(s);
  } else {
    console.log(s);
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

// -----------------------------------------------------------------------------
// PII scrubbing.
//
// Every structured payload passed through emit() is walked and any key
// matching PHI_KEY_NAMES gets its value replaced with '[redacted]'. This
// is the primary guard, not a Sentry-only hook — the log line hitting
// stdout / Vercel logs / any downstream sink is the one that's scrubbed.
//
// SEC-007 followup: the old broad pattern /email|phone|...|name/i also
// matched serviceName / organizationName / providerName / hostname,
// stripping legitimate operational context. This narrower list matches
// exact key names known to carry client PII. New PII keys must be added
// here explicitly — that's the point.
//
// Not covered here: value-level PII (a phone number substring inside an
// arbitrary `err.message` string). That is a separate concern —
// documented as an open item in docs/rbac-status.md. Fixing it means
// intercepting err.message at the boundary, not in the logger.
// -----------------------------------------------------------------------------

const PHI_KEY_NAMES: ReadonlySet<string> = new Set([
  // Contact
  'email',
  'phone',
  // Legal / demographic
  'dob',
  'address',
  // Client identifiers — patterns we actually pass around
  'customerName',
  'patientName',
  'clientName',
  'fullName',
  'customer_name',
  'patient_name',
  'client_name',
  'full_name',
  // Sensitive-category fields (Georgia 2024 data protection law)
  'allergies',
  'clinicalNotes',
  'clinical_notes',
  // Auth secrets — never in a log line
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'refreshToken',
  'accessToken',
  'apiKey',
  'authSecret',
]);

export function scrubPhi<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrubPhi) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PHI_KEY_NAMES.has(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = scrubPhi(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

// -----------------------------------------------------------------------------
// Error-message sanitizer.
//
// Strips PII patterns that frequently appear in third-party error messages
// (Postmark, SMS Office, Stripe, pg driver) before the message is passed to
// a log call. Complements scrubPhi (which covers structured keys) for the
// "value-level PII inside a string" case documented in docs/rbac-status.md.
//
// Patterns stripped:
//   • PostgreSQL DETAIL clauses — "DETAIL: Key (email) = (bob@…) already exists"
//   • E.164 phone numbers — "+995551234567"
//   • Email addresses — "user@example.com"
//   • Connection strings — "postgresql://user:pass@host/db"
// -----------------------------------------------------------------------------

/**
 * Return a log-safe version of `err.message`. Use this instead of
 * `(err as Error).message` anywhere you are passing an error from a
 * third-party provider (email, SMS, Stripe, pg driver) to a log call.
 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/DETAIL:\s+[^\n]+/gi, 'DETAIL: [redacted]')
    .replace(/\+\d{7,15}/g, '[phone]')
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgresql://[connection-string]');
}

// Signature matches Sentry's beforeSend hook so plugging in Sentry is one line.
export function sentryBeforeSend(event: unknown): unknown {
  const ctx = storage.getStore();
  const scrubbed = scrubPhi(event) as Record<string, unknown>;
  if (ctx) {
    scrubbed.tags = { ...(scrubbed.tags ?? {}), orgId: ctx.orgId, requestId: ctx.requestId };
  }
  return scrubbed;
}
