// -----------------------------------------------------------------------------
// Pure scrubbing primitives — no Node built-ins, no request context.
//
// P17-007: these lived in lib/logger.ts, whose first line is
// `import { AsyncLocalStorage } from 'node:async_hooks'`. That made the whole
// module unimportable from the browser, and sentry.client.config.ts imports
// sentryBeforeSend from it. Wiring the browser Sentry init up as it stood
// failed the build outright:
//
//   the chunking context (unknown) does not support external modules
//   (request: node:async_hooks)
//
// So sentry.client.config.ts was not merely unreferenced — it could not have
// been referenced. Anyone adding withSentryConfig would have hit this on their
// first build.
//
// Splitting the pure half out lets the browser scrub events with exactly the
// same rules the server uses, which matters: one scrubber means one list of
// sensitive keys, and a PHI field added here is redacted on both sides.
// lib/logger.ts re-exports everything below, so existing imports are unchanged.
// -----------------------------------------------------------------------------

const MAX_DEPTH = 8;
const MAX_STRING_LEN = 2000;
const MAX_ARRAY_LEN = 50;
const MAX_KEYS = 100;

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

// Sentry receives SERIALIZED exceptions, not Error instances. Keep this
// stricter egress policy separate from the operational logger: applying only
// scrubSensitive to exception.values[].value left embedded addresses and URL
// credentials intact. This closes known patterns, not arbitrary clinical prose.
const SENTRY_OMITTED_KEYS = new Set([
  'user',
  'headers',
  'cookie',
  'cookies',
  'query_string',
  'body',
  'requestbody',
  'request_body',
  'responsebody',
  'response_body',
  'vars',
  'locals',
  '__proto__',
  'constructor',
  'prototype',
]);
const SENTRY_PRIVATE_KEYS = new Set([
  'access_token',
  'refresh_token',
  'session_token',
  'id_token',
  'clientsecret',
  'client_secret',
  'sentry_auth_token',
  'dsn',
]);
const SENTRY_URL_KEYS = new Set([
  'url',
  'uri',
  'abs_path',
  'filename',
  'from',
  'to',
  'href',
  'src',
  'referer',
  'referrer',
  'path',
]);

/** Strip opaque URL components without changing source-map path spelling. */
function stripSentryUrl(value: string): string {
  // String operations deliberately handle relative and malformed URLs too;
  // a parser failure must never return a credential-bearing original URL.
  const path = value.split(/[?#]/, 1)[0];
  return path.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/]*@/i, '$1') || '[redacted-url]';
}

function sanitizeSentryText(value: string, key: string): string {
  // Dropping an oversized string also avoids retaining a partially truncated
  // credential whose suffix would have been needed to recognize its format.
  if (value.length > MAX_STRING_LEN) return '[truncated]';

  const clean = (text: string): string => {
    if (SENTRY_URL_KEYS.has(key) || /^(?:\.{0,2}\/|[?#])/.test(text)) {
      text = stripSentryUrl(text);
    }
    // URLs can occur inside serialized exception and breadcrumb messages, not
    // only fields named "url". Remove their opaque components before contact
    // redaction, which could otherwise hide the @ separating URL credentials.
    text = text.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>]+/gi, stripSentryUrl);
    text = text.replace(
      /(^|[\s("'=])((?:\.{0,2}\/)[^\s"'<>]*[?#][^\s"'<>]*)/g,
      (_, prefix: string, url: string) => prefix + stripSentryUrl(url),
    );
    return sanitizeErrorMessage(text)
      .replace(/\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[token]')
      .replace(/\bsntry[su]_[A-Za-z0-9+/_=-]+/g, '[token]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  };

  // Percent-encoded addresses/URLs are still sensitive. Decode only for
  // detection, with a small bound; never rewrite encoded source-map paths.
  let decoded = value;
  for (let i = 0; i < 2 && decoded.includes('%'); i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  if (decoded !== value && clean(decoded) !== decoded) return '[redacted]';
  return looksLikeSecret(value) ? '[redacted]' : clean(value);
}

/**
 * Error-event egress policy shared by browser/server/edge beforeSend hooks.
 * Copies rather than mutates; retains symbolication and release-probe fields.
 * Opaque HTTP bodies, headers/cookies, users and frame locals are not telemetry.
 * Other structured fields retain the logger's sensitive-key policy, with
 * additional string/URL sanitization. This is not an arbitrary-PHI classifier.
 */
export function scrubSentryEvent<T>(event: T): T | null {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, key = '', depth = 0): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return sanitizeSentryText(value, key);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return '[unsupported]';
    if (typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[truncated]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (value instanceof Error) {
      return {
        _error: true,
        name: sanitizeSentryText(value.name, 'name'),
        message: sanitizeSentryText(value.message, 'message'),
      };
    }
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_LEN).map((item) => visit(item, key, depth + 1));
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    for (const field of keys.slice(0, MAX_KEYS)) {
      const lower = field.toLowerCase();
      if (SENTRY_OMITTED_KEYS.has(lower)) continue;
      // No body, query, header, environment or other unreviewed request fields.
      if (key === 'request' && lower !== 'url' && lower !== 'method') continue;
      if (SENSITIVE_KEYS.has(lower) || SENTRY_PRIVATE_KEYS.has(lower)) {
        out[field] = '[redacted]';
      } else {
        out[field] = visit((value as Record<string, unknown>)[field], lower, depth + 1);
      }
    }
    if (keys.length > MAX_KEYS) out._truncated = true;
    return out;
  };

  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    return visit(event) as T;
  } catch {
    // A hostile getter/proxy must not bypass scrubbing or break the request.
    // Sentry interprets null from beforeSend as a deliberately dropped event.
    return null;
  }
}
