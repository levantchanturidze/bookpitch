import { describe, it, expect } from 'vitest';
import { MockAssistant } from '@/lib/assistant/models/mock';
import type { AssistantContext } from '@/lib/assistant/model';

// Reference date: Wed 2027-05-05 12:00 UTC. Same anchor as other tests so
// "tomorrow" / "next tuesday" / weekday resolution is deterministic.
const REF = new Date(Date.UTC(2027, 4, 5, 12, 0, 0));

const CTX: AssistantContext = {
  referenceDate: REF.toISOString(),
  location: { id: 'loc-1', name: 'Grand Medical Suite', type: 'clinic' },
  staff: [
    { id: 'staff-1', name: 'Rachel Kross', roleTitle: 'Physiotherapist', specialty: null },
    { id: 'staff-2', name: 'Dr. Helen Vance', roleTitle: 'GP', specialty: 'Family Medicine' },
  ],
  services: [
    { id: 'svc-1', name: 'Physiotherapy Session', durationMinutes: 45, price: 95 },
    { id: 'svc-2', name: 'General Consultation', durationMinutes: 30, price: 120 },
  ],
  customers: [
    { id: 'cust-1', name: 'Sarah Jenkins' },
    { id: 'cust-2', name: 'Michael Chen' },
  ],
};

describe('MockAssistant', () => {
  const assistant = new MockAssistant();

  it('resolves "book Sarah Jenkins with Rachel Kross tomorrow at 3pm"', async () => {
    const res = await assistant.draft('book Sarah Jenkins with Rachel Kross tomorrow at 3pm', CTX);
    expect(res.status).toBe('draft');
    if (res.status !== 'draft') return;
    expect(res.customerId).toBe('cust-1');
    expect(res.staffId).toBe('staff-1');
    expect(res.startsAt).toBe('2027-05-06T15:00:00.000Z');
  });

  it('resolves "book Michael Chen with Dr. Vance next Monday morning"', async () => {
    const res = await assistant.draft('book michael chen with dr. vance next monday morning', CTX);
    expect(res.status).toBe('draft');
    if (res.status !== 'draft') return;
    expect(res.customerId).toBe('cust-2');
    expect(res.staffId).toBe('staff-2');
    // Ref = Wed 2027-05-05. Next Monday = 2027-05-10.
    expect(res.startsAt.slice(0, 10)).toBe('2027-05-10');
    expect(res.startsAt.slice(11, 16)).toBe('09:00');
  });

  it('resolves "book Sarah Jenkins with Vance in 2 days at 15:30"', async () => {
    // Full-name customer + last-name-only staff.
    const res = await assistant.draft('book sarah jenkins with vance in 2 days at 15:30', CTX);
    expect(res.status).toBe('draft');
    if (res.status !== 'draft') return;
    expect(res.startsAt).toBe('2027-05-07T15:30:00.000Z');
    expect(res.staffId).toBe('staff-2');
  });

  it('picks the named service when one matches', async () => {
    const res = await assistant.draft(
      'book Sarah Jenkins with Rachel Kross for Physiotherapy Session tomorrow at 10am',
      CTX,
    );
    expect(res.status).toBe('draft');
    if (res.status !== 'draft') return;
    expect(res.serviceId).toBe('svc-1');
    expect(res.warnings.length).toBe(0);
  });

  it('defaults to the first service with a warning when none named', async () => {
    const res = await assistant.draft('book Sarah Jenkins with Rachel Kross tomorrow at 10am', CTX);
    expect(res.status).toBe('draft');
    if (res.status !== 'draft') return;
    expect(res.serviceId).toBe('svc-1');
    expect(res.warnings.some((w) => w.toLowerCase().includes('default'))).toBe(true);
  });

  it('clarifies when the customer is missing', async () => {
    const res = await assistant.draft('with Rachel Kross tomorrow at 3pm', CTX);
    expect(res.status).toBe('clarify');
    if (res.status !== 'clarify') return;
    expect(res.question.toLowerCase()).toContain('patient');
  });

  it('clarifies when the time is missing', async () => {
    const res = await assistant.draft('book Sarah Jenkins with Rachel Kross tomorrow', CTX);
    expect(res.status).toBe('clarify');
    if (res.status !== 'clarify') return;
    expect(res.question.toLowerCase()).toContain('time');
  });
});
