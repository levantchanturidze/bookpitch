import type { SendResult, SmsProvider } from '../index';

// -----------------------------------------------------------------------------
// SMSOffice.ge — the standard Georgian bulk-SMS provider.
// Docs: https://smsoffice.ge/api  (GET-style endpoint, key in query).
//
// Requires:
//   SMSOFFICE_API_KEY  — the "key" from smsoffice.ge → API panel.
//   SMSOFFICE_SENDER   — the approved alphanumeric sender ID.
//
// PHI rule: never log `to` or `body`. See lib/messaging/sms/mock.ts for the
// contract; the audit trail lives in message_log, not in server stdout.
// -----------------------------------------------------------------------------

const SEND_URL = 'https://smsoffice.ge/api/v2/send/';
const REQUEST_TIMEOUT_MS = 10_000;

export class SmsOfficeProvider implements SmsProvider {
  readonly name = 'smsoffice';

  async send(to: string, body: string): Promise<SendResult> {
    const key = requireEnv('SMSOFFICE_API_KEY');
    const sender = requireEnv('SMSOFFICE_SENDER');

    const params = new URLSearchParams({
      key,
      destination: normalizeGeorgianMsisdn(to),
      sender,
      content: body,
    });

    const res = await fetchWithTimeout(`${SEND_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`SMSOffice send failed (${res.status})`);
    }
    // API responds with either {"Success":true,"MessageId":<int>} or
    // {"Success":false,"ErrorCode":<int>,"Message":"..."}.
    const json = (await res.json()) as {
      Success?: boolean;
      MessageId?: number | string;
      ErrorCode?: number;
    };
    if (!json.Success || json.MessageId == null) {
      throw new Error(`SMSOffice rejected the send (code ${json.ErrorCode ?? '?'})`);
    }
    return { providerMsgId: `sms_${json.MessageId}` };
  }
}

// Georgian numbers are 9 digits after the country code (995). SMSOffice
// accepts the local form; if callers pass +995xxxxxxxxx, strip the prefix.
function normalizeGeorgianMsisdn(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('995') && digits.length === 12) return digits.slice(3);
  return digits;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — required for SMSOffice`);
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
