import { randomBytes } from 'node:crypto';
import { log } from '@/lib/logger';
import type { EmailProvider, SendResult } from '../index';

// Mock email provider — swap for postmark.ts / resend.ts once we have
// an API key. Same redaction rule as the SMS mock: NO to-address,
// NO subject, NO body content in the log line. Patient contacts +
// rendered templates carry PII/clinical fields and must not leak into
// application logs. The `message_log` row is the audit-friendly record.
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';

  async send(_to: string, subject: string, body: string): Promise<SendResult> {
    const providerMsgId = `mock_email_${randomBytes(6).toString('hex')}`;
    log.info('messaging.email.mock', {
      providerMsgId,
      subjectLen: subject.length,
      bodyLen: body.length,
    });
    return { providerMsgId };
  }
}
