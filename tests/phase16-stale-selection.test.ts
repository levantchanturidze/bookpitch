import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSequencer } from '@/components/patients/sequencer';

// -----------------------------------------------------------------------------
// F16-008. Detail is now fetched per selection, which introduces a race the
// old "everything is already in props" design could not have: click A, click B,
// A answers last, A's clinical record renders under B's name.
//
// The component guards it with createSequencer(). This exercises that guard
// with genuinely out-of-order resolution rather than asserting it exists.
// -----------------------------------------------------------------------------

/** Resolves after `ms`, so responses can be made to land out of order. */
function later<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('F16-008 · a superseded response cannot write', () => {
  it('only the newest ticket is current', () => {
    const seq = createSequencer();
    const a = seq.next();
    const b = seq.next();
    expect(seq.isCurrent(a)).toBe(false);
    expect(seq.isCurrent(b)).toBe(true);
  });

  it('invalidate() supersedes everything in flight', () => {
    const seq = createSequencer();
    const a = seq.next();
    expect(seq.isCurrent(a)).toBe(true);
    seq.invalidate();
    expect(seq.isCurrent(a)).toBe(false);
  });

  it('the slow first response loses to the fast second one', async () => {
    const seq = createSequencer();
    const rendered: string[] = [];

    async function select(id: string, delayMs: number) {
      const ticket = seq.next();
      const record = await later(`record-of-${id}`, delayMs);
      if (!seq.isCurrent(ticket)) return; // stale — drop it
      rendered.push(record);
    }

    // A is requested first and answers last: exactly the ordering that used to
    // put the wrong patient on screen.
    const a = select('A', 60);
    const b = select('B', 5);
    await Promise.all([a, b]);

    expect(rendered).toEqual(['record-of-B']);
    expect(rendered).not.toContain('record-of-A');
  });

  it('survives a burst of rapid selections — only the last one renders', async () => {
    const seq = createSequencer();
    const rendered: string[] = [];
    const ids = ['A', 'B', 'C', 'D', 'E'];

    await Promise.all(
      ids.map(async (id, i) => {
        const ticket = seq.next();
        // Earlier selections are made deliberately slower.
        const record = await later(`record-of-${id}`, (ids.length - i) * 12);
        if (!seq.isCurrent(ticket)) return;
        rendered.push(record);
      }),
    );

    expect(rendered).toEqual(['record-of-E']);
  });

  // Complement: without the guard, the same interleaving renders the wrong
  // record. This is the defect being prevented, demonstrated in isolation.
  it('without the guard the stale record wins', async () => {
    const rendered: string[] = [];
    async function selectUnguarded(id: string, delayMs: number) {
      rendered.push(await later(`record-of-${id}`, delayMs));
    }
    await Promise.all([selectUnguarded('A', 60), selectUnguarded('B', 5)]);
    expect(rendered[rendered.length - 1]).toBe('record-of-A');
  });

  it('the patients page no longer loads treatment history for every customer', () => {
    const page = readFileSync('app/(app)/patients/page.tsx', 'utf8');
    expect(page).not.toMatch(/treatmentHistory/);
    expect(page).toMatch(/CUSTOMER_LIST_SELECT/);
    expect(page).toMatch(/take: CUSTOMER_PAGE_DEFAULT \+ 1/);

    // And the component reaches for detail per selection instead.
    const list = readFileSync('components/patients/PatientList.tsx', 'utf8');
    expect(list).toMatch(/\/api\/customers\/\$\{id\}/);
    expect(list).toMatch(/status: 'loading'/);
    expect(list).toMatch(/status: 'error'/);
  });
});
