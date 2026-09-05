// -----------------------------------------------------------------------------
// Minting a TOTP code that is still valid when the request reaches the verifier.
//
// THE INCIDENT. CI run 33962683939, the push build on merge commit `9cc6582`:
//
//   FAIL tests/platform-break-glass.test.ts > SUPER_ADMIN starts with correct
//        password + TOTP
//   AssertionError: expected 400 to be 200
//
// The response landed at 11:14:00.045Z after 111ms, so the request began at
// ~11:13:59.934Z — 66ms before a 30-second step boundary, and was verified
// after it. Reproduced against the real endpoint under controlled time:
//
//   generated 100ms BEFORE a boundary, verified 45ms after
//       -> 400 {"error":"invalid or expired TOTP code"}
//   identical request wholly inside one step
//       -> 200 {"sessionId":"…"}
//
// So this was the test racing the clock, not the application misbehaving.
//
// WHY THE APPLICATION IS RIGHT. `lib/platform/mfa.ts` calls otplib's `verify`
// without `epochTolerance`, which means zero tolerance: a code is accepted only
// during the exact step it was minted in. Measured, not assumed — see
// `tests/totp-step-boundary.test.ts`, which drives the real endpoint at pinned
// instants and asserts that neither the previous nor the next step is accepted.
//
// Widening that tolerance would make this flake disappear. otplib's own docs
// suggest `epochTolerance: 30` as "standard" for 2FA and `[5, 0]` as
// RFC-compliant; applied to this verifier, the first turns three of those
// strictness tests green and the second turns one green. Both extend how long a
// shoulder-surfed code stays usable, on the endpoint that grants SUPER_ADMIN
// access to client PII and clinical records. That is buying test convenience
// with authentication strength, which is why those tests exist: they fail, by
// measurement rather than by assertion about source text, if anyone tries.
//
// WHAT THIS FIXES INSTEAD. The precondition a test needs is "a code that is
// still valid when it arrives". Minting at an arbitrary instant does not
// establish that — near the end of a step there may be only milliseconds left.
// So: if the current step has less headroom than a request could plausibly
// need, wait for the next step and mint at the top of it.
//
// This is a bound, not a coin flip. A failure now requires a single request to
// take longer than MIN_HEADROOM_MS; the observed CI request took 111ms, a 27x
// margin. It is honest to call that "practically impossible" rather than
// "impossible" — the fully deterministic version would require freezing the
// clock around live database calls, which is a larger and riskier change than
// the defect warrants.
// -----------------------------------------------------------------------------
import { generate as totpGenerate } from '@otplib/totp';
import { NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';

/** The plugin set `lib/platform/mfa.ts` uses. Tests must match it exactly. */
export const TOTP_OPTS = {
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
};

/** RFC 6238 default step, and what otplib uses here. */
export const TOTP_STEP_MS = 30_000;

/**
 * Validity a freshly minted code must still have ahead of it.
 *
 * 3s against an observed request time of 111ms. Raising it costs test wall
 * time — a wait happens on roughly 10% of calls and averages ~150ms — and
 * lowering it narrows the margin over a loaded CI runner.
 */
export const MIN_HEADROOM_MS = 3_000;

/** Milliseconds left in the current TOTP step. */
export function stepRemainingMs(now = Date.now()): number {
  return TOTP_STEP_MS - (now % TOTP_STEP_MS);
}

/**
 * How long to wait before minting, so the code has `minHeadroomMs` of validity.
 *
 * Split out from `freshTotpCode` because the interesting part is this decision,
 * and it only fires on ~10% of calls at an instant no test controls. As a pure
 * function of the clock it can be checked at pinned instants, in microseconds,
 * instead of a test sitting through a real 27-second wait to reach the branch.
 *
 * Returns 0 when the current step already has enough left.
 *
 * @param minHeadroomMs required remaining validity
 * @param now injectable for tests
 */
export function waitMsForHeadroom(minHeadroomMs: number, now = Date.now()): number {
  const remaining = stepRemainingMs(now);
  // +20ms so we land inside the new step rather than exactly on its edge.
  return remaining < minHeadroomMs ? remaining + 20 : 0;
}

/**
 * A TOTP code with at least `minHeadroomMs` of validity ahead of it.
 *
 * Waits for the next step only when the current one is nearly over, so the
 * common path costs nothing.
 */
export async function freshTotpCode(
  secret: string,
  minHeadroomMs: number = MIN_HEADROOM_MS,
): Promise<string> {
  const wait = waitMsForHeadroom(minHeadroomMs);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return totpGenerate({ ...TOTP_OPTS, secret });
}
