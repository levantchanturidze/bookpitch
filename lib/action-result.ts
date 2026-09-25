// -----------------------------------------------------------------------------
// One safe result contract for user-facing Server Actions — CLIENT-SAFE half.
//
// U-01 (production UAT, 2026-09-25). Saving an availability window of
// 18:00 → 09:00 was correctly refused — `lib/admin.ts` throws
// `InvalidInputError('window 18:00-09:00 ends at or before it starts')`, and the
// table additionally carries CHECK (end_time > start_time). What the operator
// SAW was:
//
//     Minified React error #441; visit https://react.dev/errors/441 …
//
// Because an error thrown out of a Server Action is masked before it crosses
// the boundary in production, the domain message never arrives; the client's
// `catch (err) { setError((err as Error).message) }` then renders whatever
// framework text survived. The same shape existed at ~20 call sites across 8
// components, including BreakGlassForm and MembersPanel — so a
// privilege-escalation refusal and a crash were indistinguishable.
//
// The fix is not to unmask exceptions. It is to stop throwing across the
// boundary at all: actions RETURN a value, and the value is plain data that
// serialises safely.
//
// WHY THIS FILE HAS NO `@/lib/auth` IMPORT
// Client components (BreakGlassForm, OrgDetail, PermissionsPanel) import
// `resultFromResponse` from here. `@/lib/auth` reaches `lib/auth/credentials.ts`
// and therefore `@node-rs/argon2`, a native module that cannot be bundled for
// the browser — the production build fails outright. So the error-class mapping
// lives in `lib/safe-action.ts`, which only ever runs on the server, and this
// module stays free of server-only dependencies.
//
// Codes mirror `mapError()` in lib/auth.ts, so an operation refused through an
// API route and the same operation refused through a Server Action disagree
// about nothing.
// -----------------------------------------------------------------------------

export type ActionErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_input'
  | 'slot_taken'
  | 'conflict'
  | 'not_found'
  | 'internal';

export type ActionResult<T = void> =
  { ok: true; data: T } | { ok: false; code: ActionErrorCode; message: string };

/**
 * The only message a user ever sees for an error we did not anticipate.
 * Deliberately free of any internal detail — no stack, no SQL, no env var, no
 * framework identifier.
 */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/** HTTP status → the same code vocabulary, mirroring `mapError()`. */
function statusCode(status: number): ActionErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'internal';
  return 'invalid_input';
}

/**
 * Client-side companion for surfaces that call an API route with `fetch`
 * instead of a Server Action.
 *
 * Those had the sibling of U-01: `if (!res.ok) throw new Error(await res.text())`
 * put the RAW response body on screen — JSON braces and all — and on a 5xx that
 * body is `{"error":"internal_error"}`, which is an internal identifier, not a
 * sentence. BreakGlassForm and OrgDetail, both privilege-sensitive, did this.
 *
 * Parses the documented `{ error }` envelope, keeps the server's intentional
 * message for 4xx, and substitutes the generic message for 5xx or an
 * unparseable body.
 */
export async function resultFromResponse<T = unknown>(
  res: Response,
): Promise<ActionResult<T | undefined>> {
  if (res.ok) {
    const data = (await res.json().catch(() => undefined)) as T | undefined;
    return { ok: true, data };
  }
  const code = statusCode(res.status);
  if (code === 'internal') {
    return { ok: false, code, message: GENERIC_ERROR_MESSAGE };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === 'string' && body.error.trim() ? body.error : null;
  return { ok: false, code, message: message ?? GENERIC_ERROR_MESSAGE };
}

/**
 * Client-side companion: turn a result into a message, or `null` on success.
 *
 * Exists so components stop reaching into thrown values. A component that
 * renders `resultMessage(res)` cannot accidentally display a framework
 * internal, because there is no path by which one reaches it.
 */
export function resultMessage(result: ActionResult<unknown>): string | null {
  return result.ok ? null : result.message;
}
