import type { EmailProvider, SendResult } from '../index';

// -----------------------------------------------------------------------------
// Resend transactional email — https://resend.com/docs/api-reference/emails/send-email
//
// Requires:
//   RESEND_API_KEY  — API key from the Resend dashboard.
//   RESEND_FROM     — verified sender, e.g. "Bookpitch <no-reply@bookpitch.ge>".
//
// PHI rule: never log `to`, `subject`, or `body`. The message_log row is the
// audit trail; server stdout stays free of patient contact details.
// -----------------------------------------------------------------------------

const SEND_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  async send(to: string, subject: string, body: string): Promise<SendResult> {
    const key = requireEnv('RESEND_API_KEY');
    const from = requireEnv('RESEND_FROM');

    const res = await fetchWithTimeout(SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text: body }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Resend send failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error('Resend response missing message id');
    return { providerMsgId: `rs_${json.id}` };
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — required for Resend`);
  return v;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
