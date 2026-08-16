import { randomBytes } from 'node:crypto';
import { log } from '@/lib/logger';
import type { SendResult, SmsProvider } from '../index';

// Mock SMS provider — swap for smsoffice.ts once we have an API key.
// Log line intentionally OMITS `to` and `body`: those contain patient
// contacts + rendered clinical content, which the spec forbids from
// application logs. The audit-friendly identifier is provider_msg_id +
// the corresponding message_log row.
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';

  async send(_to: string, body: string): Promise<SendResult> {
    const providerMsgId = `mock_sms_${randomBytes(6).toString('hex')}`;
    log.info('messaging.sms.mock', { providerMsgId, bodyLen: body.length });
    return { providerMsgId };
  }
}
