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

import { scrubSensitive } from './scrub';

// Re-exported so every existing `from "@/lib/logger"` import keeps working.
export { scrubSensitive, scrubPhi, sanitizeErrorMessage } from './scrub';

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

// Signature matches Sentry's beforeSend hook so plugging in Sentry is one line.
export function sentryBeforeSend(event: unknown): unknown {
  const ctx = storage.getStore();
  const scrubbed = scrubSensitive(event) as Record<string, unknown>;
  if (ctx) {
    scrubbed.tags = { ...(scrubbed.tags ?? {}), orgId: ctx.orgId, requestId: ctx.requestId };
  }
  return scrubbed;
}
