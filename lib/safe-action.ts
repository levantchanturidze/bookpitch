import * as Sentry from '@sentry/nextjs';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  SlotTakenError,
  UnauthenticatedError,
} from '@/lib/auth';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import {
  type ActionErrorCode,
  type ActionResult,
  GENERIC_ERROR_MESSAGE,
} from '@/lib/action-result';

// -----------------------------------------------------------------------------
// U-01, server half: the wrapper every user-facing Server Action runs inside.
//
// Separate from lib/action-result.ts because it imports the error classes from
// `@/lib/auth`, which transitively pulls in `@node-rs/argon2`. That is fine on
// the server and fatal in a client bundle, so the split is load-bearing rather
// than cosmetic — importing this file from a client component breaks the build,
// which is the correct failure mode.
// -----------------------------------------------------------------------------

/** Map a thrown value to a code, or `null` when it is not a domain error. */
function domainCode(err: unknown): ActionErrorCode | null {
  // RateLimitedError and AssistantQuotaExceededError extend InvalidInputError,
  // so they are covered by that branch and keep their own messages.
  if (err instanceof UnauthenticatedError) return 'unauthenticated';
  if (err instanceof ForbiddenError) return 'forbidden';
  if (err instanceof SlotTakenError) return 'slot_taken';
  if (err instanceof ConflictError) return 'conflict';
  if (err instanceof NotFoundError) return 'not_found';
  if (err instanceof InvalidInputError) return 'invalid_input';
  return null;
}

/**
 * Run a Server Action body and convert its outcome into an `ActionResult`.
 *
 * Success returns `{ ok: true, data }`. A deliberate domain failure returns
 * `{ ok: false, code, message }` with the message the domain layer wrote. An
 * unexpected failure returns the generic message and reports the real error to
 * the logger and to Sentry — it is not re-thrown, because throwing is exactly
 * what produced the masked framework text in the first place.
 *
 * @param name Stable identifier for logs, e.g. `'settings.setAvailability'`.
 */
export async function safeAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const code = domainCode(err);
    if (code) {
      // Expected refusal. The message was authored for this audience.
      log.warn('action.refused', { action: name, code });
      return { ok: false, code, message: (err as Error).message };
    }
    // Unexpected. The user gets nothing but the generic message, and the real
    // error is preserved where engineers look. Swallowing without reporting
    // would be the other failure this codebase keeps finding, so it is sent to
    // Sentry explicitly here — which is what `throw` was relying on the
    // platform to do.
    log.error('action.failed', { action: name, error: sanitizeErrorMessage(err) });
    Sentry.captureException(err, { tags: { action: name, surface: 'server-action' } });
    return { ok: false, code: 'internal', message: GENERIC_ERROR_MESSAGE };
  }
}
