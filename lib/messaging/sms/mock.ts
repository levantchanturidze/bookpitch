import { randomBytes } from 'node:crypto';
import type { SendResult, SmsProvider } from '../index';

// Mock SMS provider — logs to the server console with the same shape a real
// provider response has. Swap for smsoffice.ts once we have an API key.
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';

  async send(to: string, body: string): Promise<SendResult> {
    const providerMsgId = `mock_sms_${randomBytes(6).toString('hex')}`;
    console.log(`[SMS/mock] to=${to} id=${providerMsgId} body=${JSON.stringify(body)}`);
    return { providerMsgId };
  }
}
