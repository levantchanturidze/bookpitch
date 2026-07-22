import type { SendResult, SmsProvider } from '../index';

// Placeholder for SMSOffice.ge integration (or MagtiCom / SMS.ge). Real API:
// https://smsoffice.ge/api. Needs SMS_API_KEY + SMS_SENDER_ID.
// Adapter shape stable; implement send() and swap SMS_PROVIDER=smsoffice.
export class SmsOfficeProvider implements SmsProvider {
  readonly name = 'smsoffice';

  async send(_to: string, _body: string): Promise<SendResult> {
    throw new Error('SMSOffice adapter is not wired yet — provide SMS_API_KEY');
  }
}
