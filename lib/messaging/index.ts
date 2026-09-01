// -----------------------------------------------------------------------------
// Messaging provider dispatch. Mirrors lib/payments/gateway.ts — adapter
// interface plus env-driven selection. Real providers (SMSOffice / Postmark
// etc.) are stubs today; wire them up when API keys land.
// -----------------------------------------------------------------------------

export type SendResult = {
  providerMsgId: string;
};

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<SendResult>;
}

export interface EmailProvider {
  readonly name: string;
  send(to: string, subject: string, body: string): Promise<SendResult>;
}

import { MockSmsProvider } from './sms/mock';
import { SmsOfficeProvider } from './sms/smsoffice';
import { MockEmailProvider } from './email/mock';
import { PostmarkEmailProvider } from './email/postmark';
import { ResendEmailProvider } from './email/resend';

/**
 * Fail closed in production (CLAUDE.md invariant 2).
 *
 * The mock adapters return a provider message id without contacting anyone, so
 * an unset variable does not surface as an error — it surfaces as a reminder
 * marked delivered that nobody received. `message_log` and the outbox both
 * record success. That is the exact shape of failure this codebase keeps
 * finding: a healthy-looking signal that means nothing.
 */
function resolveProviderName(variable: string): string | null {
  const configured = (process.env[variable] ?? '').trim();
  if (configured) return configured.toLowerCase();
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${variable} must be set in production — refusing to default to the mock provider`,
    );
  }
  return null;
}

function assertMockAllowed(variable: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${variable}=mock is not permitted in production — nothing would be delivered`);
  }
}

export function getSmsProvider(): SmsProvider {
  const name = resolveProviderName('SMS_PROVIDER');
  if (name === null) return new MockSmsProvider();
  switch (name) {
    case 'mock':
      assertMockAllowed('SMS_PROVIDER');
      return new MockSmsProvider();
    case 'smsoffice':
      return new SmsOfficeProvider();
    default:
      throw new Error(`Unknown SMS_PROVIDER: ${name}`);
  }
}

export function getEmailProvider(): EmailProvider {
  const name = resolveProviderName('EMAIL_PROVIDER');
  if (name === null) return new MockEmailProvider();
  switch (name) {
    case 'mock':
      assertMockAllowed('EMAIL_PROVIDER');
      return new MockEmailProvider();
    case 'postmark':
      return new PostmarkEmailProvider();
    case 'resend':
      return new ResendEmailProvider();
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${name}`);
  }
}
