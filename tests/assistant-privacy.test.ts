import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type {
  AppointmentAssistant,
  AssistantContext,
  AssistantResult,
} from '@/lib/assistant/model';

// -----------------------------------------------------------------------------
// Privacy contract test — locks the spec rule:
//   "never send patient clinical fields to the model"
//
// draftAppointment is the ONE place the assistant sees org data. If that
// pipeline ever starts loading customer.email / phone / dob / allergies /
// clinicalNotes into the context handed to the adapter, this test fails.
//
// Runs against a throwaway org so it doesn't perturb tests that assert exact
// customer counts (rls, customers-api) or that decrypt the seeded customer
// list.
// -----------------------------------------------------------------------------

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { encryptField } = await import('@/lib/crypto');
const modelModule = await import('@/lib/assistant/model');
const { draftAppointment } = await import('@/lib/assistant/draft');

// Deliberately-unusual strings so substring search on the serialized ctx
// is unambiguous.
const SENSITIVE = {
  email: 'privacy-probe-9f3a@example.invalid',
  phone: '+1 (555) 909-0001',
  dob: new Date('1988-02-14T00:00:00Z'),
  dobIso: '1988-02-14',
  allergiesPlain: 'PROBE-ALLERGY-STRING-XYZ',
  notesPlain: 'PROBE-NOTES-STRING-QQQ',
};

describe('assistant privacy — no PHI in the context handed to the model', () => {
  let orgId: string;
  let userId: string;
  let clinicLocationId: string;
  let probeCustomerId: string;

  beforeAll(async () => {
    const seeded = await withoutRls(async (tx) => {
      const org = await tx.organization.create({
        data: { name: `privacy-probe-org-${Date.now()}` },
      });
      const clinic = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'Probe Clinic' },
      });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `probe-${Date.now()}@bookpitch.dev`,
          email: `probe-${Date.now()}@bookpitch.dev`,
          fullName: 'Probe Owner',
          passwordHash: 'x',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });
      const probe = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'Privacy Probe',
          email: SENSITIVE.email,
          phone: SENSITIVE.phone,
          dob: SENSITIVE.dob,
          // Encrypted the same way seed.ts + the app writes them, so we
          // don't trip decrypt() in any concurrent list read.
          allergies: encryptField(SENSITIVE.allergiesPlain),
          clinicalNotes: encryptField(SENSITIVE.notesPlain),
        },
      });
      return { org, clinic, user, probe };
    });
    orgId = seeded.org.id;
    userId = seeded.user.id;
    clinicLocationId = seeded.clinic.id;
    probeCustomerId = seeded.probe.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      if (probeCustomerId) await tx.customer.delete({ where: { id: probeCustomerId } });
      if (userId) {
        await tx.membership.deleteMany({ where: { userId } });
        await tx.appUser.delete({ where: { id: userId } });
      }
      if (clinicLocationId) await tx.location.delete({ where: { id: clinicLocationId } });
      if (orgId) await tx.organization.delete({ where: { id: orgId } });
    });
  });

  it('draftAppointment never puts email / phone / dob / allergies / notes into the AssistantContext', async () => {
    let captured: AssistantContext | undefined;
    const stub: AppointmentAssistant = {
      name: 'privacy-stub',
      async draft(_prompt, ctx): Promise<AssistantResult> {
        captured = ctx;
        return { status: 'clarify', question: 'stub' };
      },
    };
    const getSpy = vi.spyOn(modelModule, 'getAssistant').mockReturnValue(stub);

    try {
      await draftAppointment(
        {
          userId,
          organizationId: orgId,
          role: 'owner',
          email: 'probe@bookpitch.dev',
        },
        clinicLocationId,
        'book Privacy Probe tomorrow at 10am',
        new Date(Date.UTC(2027, 4, 5, 12, 0, 0)),
      );
    } finally {
      getSpy.mockRestore();
    }

    expect(captured, 'assistant was never invoked').toBeDefined();
    const serialized = JSON.stringify(captured);

    // Sanity: the probe customer we planted MUST appear (name only), so we
    // know we're looking at a populated list, not empty.
    expect(serialized).toContain('Privacy Probe');
    expect(serialized).toContain(probeCustomerId);

    // These must NEVER appear — plaintext PII/PHI.
    for (const forbidden of [
      SENSITIVE.email,
      SENSITIVE.phone,
      SENSITIVE.dobIso,
      SENSITIVE.allergiesPlain,
      SENSITIVE.notesPlain,
    ]) {
      expect(
        serialized.includes(forbidden),
        `sensitive value "${forbidden}" leaked into AssistantContext`,
      ).toBe(false);
    }

    // Structural belt & braces: customer shape is id + name only.
    const probeInCtx = captured!.customers.find((c) => c.id === probeCustomerId);
    expect(probeInCtx).toBeDefined();
    expect(Object.keys(probeInCtx!).sort()).toEqual(['id', 'name']);
  });
});
