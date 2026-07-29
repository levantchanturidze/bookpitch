import { AsyncLocalStorage } from 'node:async_hooks';

// -----------------------------------------------------------------------------
// Structured logger + request context (orgId, requestId, actorUserId).
//
// - AsyncLocalStorage carries the context across await boundaries so we don't
//   have to thread it through every function signature.
// - Every emitted line is one JSON object; downstream (Vercel, Datadog,
//   Sentry) all ingest this shape trivially.
// - PHI rule: NEVER call log() with a customer name, email, phone, DOB,
//   allergies, or clinical notes as a value. See `scrubPhi` for the strings
//   we defensively drop — it's belt & braces, not the primary guard.
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
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    requestId: ctx?.requestId,
    orgId: ctx?.orgId,
    actorUserId: ctx?.actorUserId,
    route: ctx?.route,
    ...(fields ?? {}),
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
// Sentry hook — safe to wire even without the SDK installed. When the SDK
// lands, import Sentry.init and pass `beforeSend: sentryBeforeSend`. This
// scrubs common PHI-looking values from breadcrumbs and event context.
// -----------------------------------------------------------------------------

const PHI_KEY_PATTERN = /email|phone|dob|allergies|clinical|notes|address|name/i;

export function scrubPhi<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrubPhi) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PHI_KEY_PATTERN.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = scrubPhi(v);
      }
    }
    return out as unknown as T;
  }
  return value;
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
