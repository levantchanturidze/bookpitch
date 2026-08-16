import { AsyncLocalStorage } from 'node:async_hooks';

// -----------------------------------------------------------------------------
// Structured logger + request context (orgId, requestId, actorUserId).
//
// - AsyncLocalStorage carries the context across await boundaries so we don't
//   have to thread it through every function signature.
// - Every emitted line is one JSON object; downstream (Vercel, Datadog,
//   Sentry) all ingest this shape trivially.
// - PHI/secret rule: scrubSensitive runs unconditionally inside emit() so
//   keys on SENSITIVE_KEYS get scrubbed to '[redacted]' before the JSON line
//   hits stdout. Value-level detection catches connection strings and bearer
//   tokens embedded inside string values.
// - The scrubber can never throw — it wraps every property access in try/catch
//   and caps recursion depth, array length, string length, and key count.
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
  const scrubbed = fields ? scrubSensitive(fields) : undefined;
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
  const s = safeStringify(line);
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
// Serialisation limits — prevent log blowout from large objects.
// -----------------------------------------------------------------------------

const MAX_DEPTH = 8;
const MAX_STRING_LEN = 2000;
const MAX_ARRAY_LEN = 50;
const MAX_KEYS = 100;

/**
 * JSON.stringify with BigInt coercion and a fallback that cannot throw.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      return val;
    });
  } catch {
    return JSON.stringify({ _serializationError: true });
  }
}

// -----------------------------------------------------------------------------
// Sensitive-field scrubbing.
//
// Two layers:
//   1. Key-name matching (SENSITIVE_KEYS) — replaces the entire value with
//      '[redacted]' for known secret field names.
//   2. Value-level detection (looksLikeSecret) — inspects string values for
//      obvious embedded secrets (connection strings, bearer tokens, JWTs)
//      regardless of the key name, with conservative patterns that minimise
//      false positives.
//
// scrubSensitive is also the primary guard for PHI (health, demographic, and
// contact data). Adding a new sensitive field requires an entry here — that's
// intentional friction.
// -----------------------------------------------------------------------------

// All entries are lowercase. Lookups use k.toLowerCase() so that mixed-case
// variants (Email, PASSWORD, mfaTotp, MFA_TOTP) are all caught without
// maintaining separate case variants for every key.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // ── Contact / demographic PII ─────────────────────────────────────────────
  'email',
  'emailaddress',
  'email_address',
  'toaddress',
  'to_address',
  'recipient',
  'phone',
  'dob',
  'address',
  // ── Client / patient names ────────────────────────────────────────────────
  'customername',
  'patientname',
  'clientname',
  'fullname',
  'customer_name',
  'patient_name',
  'client_name',
  'full_name',
  // ── Clinical / sensitive-category fields ──────────────────────────────────
  'allergies',
  'clinicalnotes',
  'clinical_notes',
  // ── Passwords and hashes ─────────────────────────────────────────────────
  'password',
  'passwordhash',
  'password_hash',
  'passworddigest',
  'hashedpassword',
  // ── Session / auth tokens ─────────────────────────────────────────────────
  'token',
  'refreshtoken',
  'accesstoken',
  'sessiontoken',
  'idtoken',
  'csrftoken',
  'authsecret',
  'authtoken',
  // ── MFA / TOTP ────────────────────────────────────────────────────────────
  'mfatotp',
  'mfatotppending',
  'totpsecret',
  'otpauthuri',
  'backupcode',
  'recoverycode',
  'recovery_code',
  'codehash',
  // ── API and HMAC keys ─────────────────────────────────────────────────────
  'apikey',
  'api_key',
  'hmackey',
  'signingkey',
  'encryptionkey',
  'secretkey',
  'secret',
  // ── Crypto internals ──────────────────────────────────────────────────────
  'iv',
  'authtag',
  'encrypteddata',
  'encryptedfield',
  'encryptedsecret',
  // ── HTTP auth headers ─────────────────────────────────────────────────────
  'cookie',
  'cookies',
  'authorization',
  'bearer',
  'x-api-key',
  // ── Database and connection strings ───────────────────────────────────────
  'connectionstring',
  'databaseurl',
  'database_url',
  'sql',
  'query',
  'params',
  // ── Network / privacy ─────────────────────────────────────────────────────
  'ip',
  'ipaddress',
  'ip_address',
  'rawip',
  'useragent',
  'user_agent',
]);

/**
 * Return true for string values that look like embedded secrets even when the
 * key name is not in SENSITIVE_KEYS. Conservative patterns only — prefer false
 * negatives over false positives that destroy operational context.
 */
function looksLikeSecret(s: string): boolean {
  if (s.length < 4) return false;
  // Database connection strings.
  if (/^postgres(?:ql)?:\/\//i.test(s)) return true;
  // HTTP bearer / basic auth headers when the entire value is an auth credential.
  if (/^Bearer\s+\S{20,}/i.test(s)) return true;
  if (/^Basic\s+[A-Za-z0-9+/=]{10,}/i.test(s)) return true;
  // Compact JWT (three base64url segments, total > 60 chars).
  if (s.length > 60 && /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(s))
    return true;
  // Email addresses — catch raw PII in arbitrary-key values.
  if (/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(s)) return true;
  // IPv4 addresses — e.g. 203.0.113.42 logged under any key name.
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) return true;
  // IPv6 addresses — compressed or full notation.
  if (/^[0-9a-fA-F:]{2,39}$/.test(s) && s.includes(':') && s.split(':').length >= 3) return true;
  return false;
}

/**
 * Recursively scrub sensitive data from a structured log payload.
 * Cannot throw — wraps every property access in try/catch.
 */
export function scrubSensitive<T>(value: T, _seen?: WeakSet<object>, _depth?: number): T {
  const seen = _seen ?? new WeakSet<object>();
  const depth = _depth ?? 0;

  try {
    if (value === null || value === undefined) return value;

    // Primitive types.
    if (typeof value === 'string') {
      const s = value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + '…' : value;
      return (looksLikeSecret(s) ? '[redacted]' : s) as unknown as T;
    }
    if (typeof value === 'bigint') return value.toString() as unknown as T;
    if (typeof value === 'function') return '[function]' as unknown as T;
    if (typeof value === 'symbol') return '[symbol]' as unknown as T;

    // Depth cap.
    if (depth >= MAX_DEPTH) return '[truncated]' as unknown as T;

    // Arrays.
    if (Array.isArray(value)) {
      const arr = value.slice(0, MAX_ARRAY_LEN).map((item) => {
        try {
          return scrubSensitive(item, seen, depth + 1);
        } catch {
          return '[error]';
        }
      });
      if (value.length > MAX_ARRAY_LEN) arr.push(`… and ${value.length - MAX_ARRAY_LEN} more`);
      return arr as unknown as T;
    }

    // Error objects — extract message only, never stack or cause chain.
    if (value instanceof Error) {
      return {
        _error: true,
        name: value.name,
        message: sanitizeErrorMessage(value),
      } as unknown as T;
    }

    // Plain objects (including Prisma errors, provider responses, etc.).
    if (typeof value === 'object') {
      // Circular reference guard.
      if (seen.has(value as object)) return '[circular]' as unknown as T;
      seen.add(value as object);

      // Enumerate keys defensively — some objects have throwing getters.
      let keys: string[] = [];
      try {
        keys = Object.keys(value as object);
      } catch {
        return '[error]' as unknown as T;
      }

      const out: Record<string, unknown> = {};
      let keyCount = 0;
      for (const k of keys) {
        if (keyCount >= MAX_KEYS) {
          out['_truncated'] = `… and ${keys.length - keyCount} more keys`;
          break;
        }
        keyCount++;
        try {
          const v = (value as Record<string, unknown>)[k];
          if (SENSITIVE_KEYS.has(k.toLowerCase())) {
            out[k] = '[redacted]';
          } else {
            out[k] = scrubSensitive(v, seen, depth + 1);
          }
        } catch {
          out[k] = '[error]';
        }
      }
      return out as unknown as T;
    }

    return value;
  } catch {
    return '[scrub-error]' as unknown as T;
  }
}

/**
 * @deprecated Use scrubSensitive instead.  scrubPhi is kept as an alias for
 * call-sites that haven't been migrated yet — both names call the same function.
 */
export const scrubPhi = scrubSensitive;

// -----------------------------------------------------------------------------
// Error-message sanitizer.
//
// Strips PII patterns that frequently appear in third-party error messages
// (Postmark, SMS Office, Stripe, pg driver) before the message is passed to
// a log call. Complements scrubSensitive (which covers structured keys) for
// the "value-level PII inside a string" case.
//
// Patterns stripped:
//   • PostgreSQL DETAIL clauses — "DETAIL: Key (email) = (bob@…) already exists"
//   • E.164 phone numbers — "+995551234567"
//   • Email addresses — "user@example.com"
//   • Connection strings — "postgresql://user:pass@host/db"
//   • SQL statements after "error at or near"
//   • Bearer / Basic credential tokens
// -----------------------------------------------------------------------------

/**
 * Return a log-safe version of `err.message`. Use this instead of
 * `(err as Error).message` anywhere you are passing an error from a
 * third-party provider (email, SMS, Stripe, pg driver) to a log call.
 */
export function sanitizeErrorMessage(err: unknown): string {
  try {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
      .replace(/DETAIL:\s+[^\n]+/gi, 'DETAIL: [redacted]')
      .replace(/\+\d{7,15}/g, '[phone]')
      .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgresql://[connection-string]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
      .slice(0, MAX_STRING_LEN);
  } catch {
    return '[error-message-unavailable]';
  }
}

// Signature matches Sentry's beforeSend hook so plugging in Sentry is one line.
export function sentryBeforeSend(event: unknown): unknown {
  const ctx = storage.getStore();
  const scrubbed = scrubSensitive(event) as Record<string, unknown>;
  if (ctx) {
    scrubbed.tags = { ...(scrubbed.tags ?? {}), orgId: ctx.orgId, requestId: ctx.requestId };
  }
  return scrubbed;
}
