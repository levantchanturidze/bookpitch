// -----------------------------------------------------------------------------
// Assistant adapter interface. Same shape as our other adapters
// (payments, messaging): env-selected implementation, mock walks the whole
// flow locally so nothing external is needed for dev/tests.
//
// The adapter's job is ONLY to turn a natural-language prompt into a
// STRUCTURED draft (or a clarifying question). Actual booking still goes
// through bookAppointmentAction so the GiST exclusion constraint remains
// the source of truth for double-booking.
// -----------------------------------------------------------------------------

export type AssistantContext = {
  // Reference "now" — the adapter uses this to resolve "tomorrow", "next
  // Tuesday" etc. Passed explicitly so tests are deterministic.
  referenceDate: string; // ISO
  location: { id: string; name: string; type: 'clinic' | 'salon' };
  staff: Array<{ id: string; name: string; roleTitle: string; specialty: string | null }>;
  services: Array<{ id: string; name: string; durationMinutes: number; price: number }>;
  customers: Array<{ id: string; name: string }>;
};

export type AssistantDraft = {
  status: 'draft';
  customerId: string | null;
  customerName: string;
  staffId: string | null;
  staffName: string;
  serviceId: string | null;
  serviceName: string;
  startsAt: string; // ISO UTC
  notes: string | null;
  warnings: string[];
};

export type AssistantClarify = {
  status: 'clarify';
  question: string;
};

export type AssistantResult = AssistantDraft | AssistantClarify;

export interface AppointmentAssistant {
  readonly name: string;
  draft(prompt: string, ctx: AssistantContext): Promise<AssistantResult>;
}

import { MockAssistant } from './models/mock';
import { GeminiAssistant } from './models/gemini';

export function getAssistant(): AppointmentAssistant {
  const name = (process.env.ASSISTANT_MODEL ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return new MockAssistant();
    case 'gemini':
      return new GeminiAssistant();
    default:
      throw new Error(`Unknown ASSISTANT_MODEL: ${name}`);
  }
}
