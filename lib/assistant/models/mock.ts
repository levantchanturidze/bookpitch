import type { AppointmentAssistant, AssistantContext, AssistantResult } from '../model';

// -----------------------------------------------------------------------------
// Mock assistant — deterministic pattern matcher over the org fixtures.
// Understands: "book <customer> with <staff> [for <service>] <date-phrase>
// [at <time>]". Enough to demo + test the whole pipeline without an API key.
// Swap to models/gemini.ts once GOOGLE_API_KEY is set.
// -----------------------------------------------------------------------------

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export class MockAssistant implements AppointmentAssistant {
  readonly name = 'mock';

  async draft(prompt: string, ctx: AssistantContext): Promise<AssistantResult> {
    const p = prompt.toLowerCase().trim();
    if (!p) {
      return { status: 'clarify', question: 'What would you like to book?' };
    }

    // Match customer + staff + optional service by longest-substring lookup.
    const customer = findByName(p, ctx.customers);
    const staff = findByName(p, ctx.staff);
    const service = findByName(p, ctx.services);

    // Anchor the reference date at the start of that UTC day.
    const now = new Date(ctx.referenceDate);
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Resolve the date phrase.
    let daysFromAnchor: number | null = null;
    if (/\btoday\b/.test(p)) daysFromAnchor = 0;
    else if (/\btomorrow\b/.test(p)) daysFromAnchor = 1;
    else {
      const inN = /\bin (\d+) days?\b/.exec(p);
      if (inN) daysFromAnchor = Number(inN[1]);
    }
    if (daysFromAnchor === null) {
      // "next tuesday" / "on friday" / bare "friday"
      const weekdayMatch = new RegExp(`\\b(?:on |next )?(${WEEKDAYS.join('|')})\\b`).exec(p);
      if (weekdayMatch) {
        const target = WEEKDAYS.indexOf(weekdayMatch[1] as (typeof WEEKDAYS)[number]);
        const current = anchor.getUTCDay();
        // "next X" and bare "X" both mean the next occurrence of X after
        // today. English is ambiguous ("next Monday" could also mean the
        // one after the coming Monday); we go with the more common
        // interpretation. If today IS X, jump 7 days.
        let delta = (target - current + 7) % 7;
        if (delta === 0) delta = 7;
        daysFromAnchor = delta;
      }
    }

    // Time-of-day: "at 3pm", "at 15:00", "afternoon"/"morning"/"evening".
    let hour: number | null = null;
    let minute = 0;
    const at12 = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(p);
    if (at12) {
      hour = Number(at12[1]);
      minute = Number(at12[2] ?? '0');
      const suffix = at12[3];
      if (suffix === 'pm' && hour < 12) hour += 12;
      if (suffix === 'am' && hour === 12) hour = 0;
    } else if (/\bmorning\b/.test(p)) hour = 9;
    else if (/\bafternoon\b/.test(p)) hour = 14;
    else if (/\bevening\b/.test(p)) hour = 18;

    // Bail with clarify if we can't build a coherent draft.
    if (!customer) {
      return {
        status: 'clarify',
        question: `Which patient did you mean? Try including the full name, e.g. "Sarah Jenkins".`,
      };
    }
    if (!staff) {
      return {
        status: 'clarify',
        question: `Which staff member? Available: ${ctx.staff
          .slice(0, 5)
          .map((s) => s.name)
          .join(', ')}.`,
      };
    }
    if (daysFromAnchor === null) {
      return {
        status: 'clarify',
        question: `When should this be? Try "tomorrow at 3pm", "next Tuesday morning", or "in 2 days".`,
      };
    }
    if (hour === null) {
      return {
        status: 'clarify',
        question: `What time? Try "at 3pm", "at 15:00", or "afternoon".`,
      };
    }

    // Default service = first active service at the location if none named.
    const resolvedService = service ?? ctx.services[0];
    const warnings: string[] = [];
    if (!service && ctx.services.length > 0) {
      warnings.push(
        `No service named — defaulting to "${resolvedService.name}". Adjust before confirming if needed.`,
      );
    }

    const startsAt = new Date(anchor.getTime() + daysFromAnchor * 86_400_000);
    startsAt.setUTCHours(hour, minute, 0, 0);

    return {
      status: 'draft',
      customerId: customer.id,
      customerName: customer.name,
      staffId: staff.id,
      staffName: staff.name,
      serviceId: resolvedService?.id ?? null,
      serviceName: resolvedService?.name ?? '',
      startsAt: startsAt.toISOString(),
      notes: null,
      warnings,
    };
  }
}

// Longest-name-first substring match — so "Dr. Marcus Sterling" beats
// "Marcus" if both appear in the prompt.
function findByName<T extends { id: string; name: string }>(
  prompt: string,
  candidates: T[],
): T | null {
  const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    const lower = c.name.toLowerCase();
    if (prompt.includes(lower)) return c;
    // Also try last-name-only for staff like "Dr. Vance" → "vance".
    const parts = lower.split(/\s+/);
    if (parts.length > 1 && prompt.includes(parts[parts.length - 1])) return c;
  }
  return null;
}
