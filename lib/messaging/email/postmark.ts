import type { EmailProvider, SendResult } from '../index';

// -----------------------------------------------------------------------------
// Postmark transactional email.
// Docs: https://postmarkapp.com/developer/api/email-api
//
// Requires:
//   POSTMARK_API_TOKEN  — the Server API token.
//   POSTMARK_FROM       — verified sender address, e.g. "no-reply@bookpitch.ge".
//
// PHI rule: never log `to`, `subject`, or `body`. The message_log row is the
// audit trail; server stdout stays free of patient contact details.
// -----------------------------------------------------------------------------

const SEND_URL = 'https://api.postmarkapp.com/email';
const REQUEST_TIMEOUT_MS = 10_000;

export class PostmarkEmailProvider implements EmailProvider {
  readonly name = 'postmark';

  async send(to: string, subject: string, body: string): Promise<SendResult> {
    const token = requireEnv('POSTMARK_API_TOKEN');
    const from = requireEnv('POSTMARK_FROM');
    const stream = process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound';

    const res = await fetchWithTimeout(SEND_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        TextBody: body,
        MessageStream: stream,
      }),
    });

    // Postmark returns 200 with ErrorCode=0 on success; non-2xx or
    // ErrorCode!=0 is a hard failure.
    if (!res.ok) throw new Error(`Postmark send failed (${res.status})`);
    const json = (await res.json()) as {
      MessageID?: string;
      ErrorCode?: number;
      Message?: string;
    };
    if (json.ErrorCode !== 0 || !json.MessageID) {
      throw new Error(`Postmark rejected the send (code ${json.ErrorCode ?? '?'})`);
    }
    return { providerMsgId: `pm_${json.MessageID}` };
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — required for Postmark`);
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
