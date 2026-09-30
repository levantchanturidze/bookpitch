import { describe, it, expect, vi, afterEach } from 'vitest';

// -----------------------------------------------------------------------------
// A sign-up's verification email is sent at sign-up, not at the next drain.
//
// createPendingRegistration() wrote the email to email_outbox and stopped. The
// only thing that sent it was the housekeeping drain, which runs when GitHub
// delivers the `3 * * * *` schedule — and on 2026-09-30 GitHub left that
// schedule undelivered for seven hours. A production sign-up that afternoon
// received nothing, while invitations from the same deployment (which call
// deliverNow) arrived within seconds.
//
// The assertion is on the outbox row's STATUS, the thing that decides whether
// a person receives mail: `sent` straight after sign-up. The complement proves
// the durability contract survived: when the provider refuses, sign-up still
// succeeds and the row is back in `pending` for the drain, not lost.
// -----------------------------------------------------------------------------

const { providerOverride } = vi.hoisted(() => ({
  providerOverride: { current: null as null | { name: string; send: () => Promise<never> } },
}));

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/messaging')>();
  return {
    ...actual,
    getEmailProvider: () => providerOverride.current ?? actual.getEmailProvider(),
  };
});

const { unsafePrismaAdmin } = await import('@/lib/db');
const { createPendingRegistration } = await import('@/lib/onboarding');
const { hashEmailForIndex } = await import('@/lib/crypto');

const created: string[] = [];

afterEach(async () => {
  providerOverride.current = null;
  for (const email of created.splice(0)) {
    await unsafePrismaAdmin.emailOutbox.deleteMany({
      where: { toAddressHash: hashEmailForIndex(email) },
    });
    await unsafePrismaAdmin.$executeRaw`DELETE FROM pending_registrations WHERE email = ${email}`;
  }
});

async function signUp(tag: string) {
  const email = `verify-delivery-${tag}-${Date.now()}@example.dev`;
  created.push(email);
  await createPendingRegistration({
    email,
    password: 'testpass123',
    fullName: 'Verify Delivery',
    orgName: 'Verify Delivery Clinic',
  });
  return unsafePrismaAdmin.emailOutbox.findMany({
    where: { toAddressHash: hashEmailForIndex(email), purpose: 'onboard.verify' },
    select: { status: true, sentAt: true, attempts: true, failureCategory: true },
  });
}

describe('sign-up delivers its verification email immediately', () => {
  it('the outbox row is already `sent` when createPendingRegistration returns', async () => {
    const rows = await signUp('ok');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(rows[0].sentAt).not.toBeNull();
  });

  it('the complement: a refused send still signs up, and leaves the row pending for the drain', async () => {
    providerOverride.current = {
      name: 'refusing',
      send: async () => {
        throw new Error('provider unavailable');
      },
    };
    const rows = await signUp('refused');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].sentAt).toBeNull();
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].failureCategory).toBe('provider_error');
  });
});
