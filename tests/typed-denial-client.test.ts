// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The actions are replaced with ones that return what the server now returns —
// typed results — so this file tests the CLIENT half: that a refusal reaches
// the person who pressed the button instead of disappearing.
const { results } = vi.hoisted(() => ({
  results: {
    cash: { ok: true, data: undefined } as unknown,
    card: { ok: true, data: undefined } as unknown,
  },
}));
vi.mock('@/components/billing/actions', () => ({
  settleCashAction: vi.fn(async () => results.cash),
  startCardCheckoutAction: vi.fn(async () => results.card),
}));

const { default: PaymentButtons } = await import('@/components/billing/PaymentButtons');
const actions = await import('@/components/billing/actions');

// -----------------------------------------------------------------------------
// Backlog F, client half. The payment buttons used to be bare <form action>
// elements in a server component, which DISCARD what the action returns. That
// was tolerable while a refusal was a thrown error (it reached the error page);
// once actions return typed results it would have made every refusal silent.
// -----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  results.cash = { ok: true, data: undefined };
  results.card = { ok: true, data: undefined };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(createElement(PaymentButtons, { appointmentId: 'appt-1' }));
  });
}
async function press(label: RegExp) {
  const button = [...container.querySelectorAll('button')].find((b) =>
    label.test(b.textContent ?? ''),
  );
  if (!button) throw new Error(`no button matching ${label}`);
  await act(async () => {
    button.form!.requestSubmit(button);
  });
}
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? '';

describe('a refused payment action is shown, not swallowed', () => {
  it('shows the refusal message from a typed result', async () => {
    results.cash = {
      ok: false,
      code: 'forbidden',
      message: 'missing permission: payment.charge',
    };
    await render();
    expect(alertText()).toBe('');
    await press(/Cash/);
    expect(actions.settleCashAction).toHaveBeenCalledTimes(1);
    expect(alertText()).toBe('missing permission: payment.charge');
  });

  it('sends the appointment id the row belongs to', async () => {
    await render();
    await press(/Cash/);
    const fd = vi.mocked(actions.settleCashAction).mock.calls.at(-1)![0] as FormData;
    expect(fd.get('appointmentId')).toBe('appt-1');
  });

  it('a success clears an earlier message', async () => {
    results.cash = { ok: false, code: 'conflict', message: 'already paid' };
    await render();
    await press(/Cash/);
    expect(alertText()).toBe('already paid');
    results.cash = { ok: true, data: undefined };
    await press(/Cash/);
    expect(alertText()).toBe('');
  });

  it('an unexpected failure shows only the generic sentence the server sent', async () => {
    results.card = {
      ok: false,
      code: 'internal',
      message: 'Something went wrong. Please try again.',
    };
    await render();
    await press(/Pay by card/);
    expect(alertText()).toBe('Something went wrong. Please try again.');
  });

  it('a redirect (no result to read) leaves no message behind', async () => {
    results.card = undefined;
    await render();
    await press(/Pay by card/);
    expect(alertText()).toBe('');
  });
});
