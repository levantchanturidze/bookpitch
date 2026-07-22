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

export function getSmsProvider(): SmsProvider {
  const name = (process.env.SMS_PROVIDER ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return new MockSmsProvider();
    case 'smsoffice':
      return new SmsOfficeProvider();
    default:
      throw new Error(`Unknown SMS_PROVIDER: ${name}`);
  }
}

export function getEmailProvider(): EmailProvider {
  const name = (process.env.EMAIL_PROVIDER ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return new MockEmailProvider();
    case 'postmark':
      return new PostmarkEmailProvider();
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${name}`);
  }
}
