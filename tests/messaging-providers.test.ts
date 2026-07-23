import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SmsOfficeProvider } from '@/lib/messaging/sms/smsoffice';
import { PostmarkEmailProvider } from '@/lib/messaging/email/postmark';

// -----------------------------------------------------------------------------
// Real messaging providers — verify request shape and PHI-in-log discipline.
// Mocks global fetch so no external HTTP happens.
// -----------------------------------------------------------------------------

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.SMSOFFICE_API_KEY = 'sms-test-key';
  process.env.SMSOFFICE_SENDER = 'BookPitch';
  process.env.POSTMARK_API_TOKEN = 'pm-token';
  process.env.POSTMARK_FROM = 'no-reply@bookpitch.ge';
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('SmsOfficeProvider', () => {
  const provider = new SmsOfficeProvider();

  it('sends via GET with key/destination/sender/content and returns providerMsgId', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Success: true, MessageId: 4242 }), { status: 200 }),
    );
    const res = await provider.send('+995598123456', 'body text');
    expect(res.providerMsgId).toBe('sms_4242');

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe('https://smsoffice.ge/api/v2/send/');
    expect(parsed.searchParams.get('key')).toBe('sms-test-key');
    expect(parsed.searchParams.get('sender')).toBe('BookPitch');
    expect(parsed.searchParams.get('destination')).toBe('598123456');
    expect(parsed.searchParams.get('content')).toBe('body text');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('throws when the API responds with Success=false', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Success: false, ErrorCode: 21 }), { status: 200 }),
    );
    await expect(provider.send('+995598123456', 'x')).rejects.toThrow(/code 21/);
  });

  it('throws on non-2xx transport failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 502 }));
    await expect(provider.send('+995598123456', 'x')).rejects.toThrow(/502/);
  });

  it('does not log the recipient or body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Success: true, MessageId: 1 }), { status: 200 }),
    );
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await provider.send('+995598123456', 'secret patient body');
    for (const call of spy.mock.calls) {
      const line = call.join(' ');
      expect(line).not.toContain('995598123456');
      expect(line).not.toContain('secret patient body');
    }
    spy.mockRestore();
  });
});

describe('PostmarkEmailProvider', () => {
  const provider = new PostmarkEmailProvider();

  it('POSTs the message with the server token header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'abc-123' }), { status: 200 }),
    );
    const res = await provider.send('to@example.com', 'Subj', 'Hi');
    expect(res.providerMsgId).toBe('pm_abc-123');
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers as HeadersInit);
    expect(headers.get('x-postmark-server-token')).toBe('pm-token');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      From: 'no-reply@bookpitch.ge',
      To: 'to@example.com',
      Subject: 'Subj',
      TextBody: 'Hi',
      MessageStream: 'outbound',
    });
  });

  it('throws when Postmark reports an ErrorCode', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid' }), { status: 200 }),
    );
    await expect(provider.send('to@example.com', 's', 'b')).rejects.toThrow(/code 300/);
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }));
    await expect(provider.send('to@example.com', 's', 'b')).rejects.toThrow(/500/);
  });

  it('does not log the recipient / subject / body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'x' }), { status: 200 }),
    );
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await provider.send('leak@example.com', 'clinical subject', 'body content');
    for (const call of spy.mock.calls) {
      const line = call.join(' ');
      expect(line).not.toContain('leak@example.com');
      expect(line).not.toContain('clinical subject');
      expect(line).not.toContain('body content');
    }
    spy.mockRestore();
  });
});
