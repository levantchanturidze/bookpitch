// -----------------------------------------------------------------------------
// F16-008 — "only the newest request may write".
//
// Selecting a patient starts a fetch. Selection can change faster than the
// network answers, and the reply that arrives last is not necessarily the reply
// that was asked for last: click A then B, B answers in 20 ms, A answers in
// 400 ms, and A's clinical record lands on screen under B's name.
//
// Every request takes a ticket before it starts and checks it before it writes.
// A superseded ticket drops its result on the floor. Extracted from the
// component so the rule can be tested directly rather than inferred from a
// screenshot.
// -----------------------------------------------------------------------------

export type Sequencer = {
  /** Claim the newest ticket. Everything older is now stale. */
  next(): number;
  /** True only for the most recently issued ticket. */
  isCurrent(ticket: number): boolean;
  /** Supersede everything in flight without starting new work. */
  invalidate(): void;
};

export function createSequencer(): Sequencer {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (ticket: number) => ticket === current,
    invalidate: () => {
      current++;
    },
  };
}
