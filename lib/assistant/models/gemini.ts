import { GoogleGenAI, Type } from '@google/genai';
import type { AppointmentAssistant, AssistantContext, AssistantResult } from '../model';

// -----------------------------------------------------------------------------
// Gemini adapter — real LLM path. Only initialised when ASSISTANT_MODEL=gemini.
// Requires GOOGLE_API_KEY (grab a free one at aistudio.google.com/apikey).
// Uses gemini-2.5-flash (fast + cheap; enough for a structured extraction
// like this). responseSchema pins the shape so we never parse free-form text.
//
// Hardening: 15s per-attempt timeout + one retry with 500ms backoff on
// transient failures (timeout, 5xx, network). Non-transient errors — bad
// API key, invalid input, quota — surface immediately.
// -----------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 500;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING, enum: ['draft', 'clarify'] },
    customerName: { type: Type.STRING, nullable: true },
    staffName: { type: Type.STRING, nullable: true },
    serviceName: { type: Type.STRING, nullable: true },
    startsAt: { type: Type.STRING, nullable: true }, // ISO 8601 UTC
    notes: { type: Type.STRING, nullable: true },
    question: { type: Type.STRING, nullable: true }, // when status=clarify
  },
  required: ['status'],
};

type ModelResponse = {
  status: 'draft' | 'clarify';
  customerName?: string | null;
  staffName?: string | null;
  serviceName?: string | null;
  startsAt?: string | null;
  notes?: string | null;
  question?: string | null;
};

export class GeminiAssistant implements AppointmentAssistant {
  readonly name = 'gemini';

  async draft(prompt: string, ctx: AssistantContext): Promise<AssistantResult> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ASSISTANT_MODEL=gemini but GOOGLE_API_KEY is not set. Get a key at aistudio.google.com/apikey or set ASSISTANT_MODEL=mock.',
      );
    }

    const client = new GoogleGenAI({ apiKey });
    const systemPreamble = buildPreamble(ctx);
    const userTurn = `Reference date (UTC): ${ctx.referenceDate}\nUser request: ${prompt}`;

    const call = () =>
      client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: systemPreamble + '\n\n' + userTurn }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      });

    const res = await withTimeoutAndRetry(call);

    const text = res.text ?? '';
    let parsed: ModelResponse;
    try {
      parsed = JSON.parse(text) as ModelResponse;
    } catch {
      return { status: 'clarify', question: 'Sorry — I could not parse that. Try rephrasing.' };
    }

    if (parsed.status === 'clarify') {
      return { status: 'clarify', question: parsed.question ?? 'Could you clarify?' };
    }

    // Resolve model-provided names back to our IDs (case-insensitive substring).
    const customer = findByName(parsed.customerName ?? '', ctx.customers);
    const staff = findByName(parsed.staffName ?? '', ctx.staff);
    const service = findByName(parsed.serviceName ?? '', ctx.services);
    const warnings: string[] = [];
    if (parsed.customerName && !customer) {
      warnings.push(`Customer "${parsed.customerName}" not found — pick from the list.`);
    }
    if (parsed.staffName && !staff) {
      warnings.push(`Staff "${parsed.staffName}" not found — pick from the list.`);
    }
    if (parsed.serviceName && !service) {
      warnings.push(`Service "${parsed.serviceName}" not found — pick a service.`);
    }

    return {
      status: 'draft',
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? parsed.customerName ?? '',
      staffId: staff?.id ?? null,
      staffName: staff?.name ?? parsed.staffName ?? '',
      serviceId: service?.id ?? null,
      serviceName: service?.name ?? parsed.serviceName ?? '',
      startsAt: parsed.startsAt ?? new Date(ctx.referenceDate).toISOString(),
      notes: parsed.notes ?? null,
      warnings,
    };
  }
}

function buildPreamble(ctx: AssistantContext): string {
  return [
    `You turn a receptionist's natural-language request into a STRUCTURED appointment draft for a clinic/salon scheduling app.`,
    `Return JSON matching the schema. If any of {customer, staff, date, time} is missing or ambiguous, return status="clarify" with a specific question.`,
    `All times are UTC ISO 8601. "Tomorrow" means +1 day from the reference date. "Next Tuesday" means the Tuesday of the next calendar week.`,
    ``,
    `Location: ${ctx.location.name} (${ctx.location.type})`,
    `Staff:`,
    ...ctx.staff.map(
      (s) => `  - ${s.name} — ${s.roleTitle}${s.specialty ? ` (${s.specialty})` : ''}`,
    ),
    `Services:`,
    ...ctx.services.map((s) => `  - ${s.name} — ${s.durationMinutes} min, ${s.price} GEL`),
    `Customers (short list):`,
    ...ctx.customers.slice(0, 30).map((c) => `  - ${c.name}`),
  ].join('\n');
}

async function withTimeoutAndRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempt = () =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('Gemini call timed out after 15s')),
        REQUEST_TIMEOUT_MS,
      );
      fn().then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (err) => {
          clearTimeout(t);
          reject(err);
        },
      );
    });
  try {
    return await attempt();
  } catch (err) {
    if (!isTransient(err)) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await attempt();
  }
}

function isTransient(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message?.toLowerCase() ?? '';
  if (msg.includes('timed out')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enetunreach'))
    return true;
  // Google SDK surfaces HTTP status on err.status in some paths.
  const status = (err as { status?: number } | undefined)?.status;
  if (status && status >= 500 && status < 600) return true;
  return false;
}

function findByName<T extends { id: string; name: string }>(
  raw: string,
  candidates: T[],
): T | null {
  if (!raw) return null;
  const needle = raw.toLowerCase().trim();
  // Exact match first, then substring.
  const exact = candidates.find((c) => c.name.toLowerCase() === needle);
  if (exact) return exact;
  return (
    candidates.find(
      (c) => c.name.toLowerCase().includes(needle) || needle.includes(c.name.toLowerCase()),
    ) ?? null
  );
}
