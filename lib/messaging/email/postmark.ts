import type { EmailProvider, SendResult } from '../index';

// Placeholder for Postmark (postmarkapp.com) or an equivalent transactional
// provider. Real API: https://postmarkapp.com/developer/api.
// Needs EMAIL_API_KEY + EMAIL_FROM.
export class PostmarkEmailProvider implements EmailProvider {
  readonly name = 'postmark';

  async send(_to: string, _subject: string, _body: string): Promise<SendResult> {
    throw new Error('Postmark adapter is not wired yet — provide EMAIL_API_KEY');
  }
}
