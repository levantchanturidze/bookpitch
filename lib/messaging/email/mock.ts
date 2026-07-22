import { randomBytes } from 'node:crypto';
import type { EmailProvider, SendResult } from '../index';

// Mock email provider — logs to the server console. Swap for postmark.ts /
// resend.ts once we have an API key.
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';

  async send(to: string, subject: string, body: string): Promise<SendResult> {
    const providerMsgId = `mock_email_${randomBytes(6).toString('hex')}`;
    console.log(
      `[EMAIL/mock] to=${to} id=${providerMsgId} subject=${JSON.stringify(subject)} body=${JSON.stringify(body)}`,
    );
    return { providerMsgId };
  }
}
