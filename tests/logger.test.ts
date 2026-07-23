import { describe, it, expect } from 'vitest';
import { scrubPhi, sentryBeforeSend, withRequestContext, log } from '@/lib/logger';

describe('logger.scrubPhi', () => {
  it('redacts values under keys matching PHI patterns', () => {
    const scrubbed = scrubPhi({
      user: { name: 'Sarah', email: 's@x.com', role: 'owner' },
      appointment: { customerPhone: '+995', notes: 'private', id: 'abc' },
    });
    expect(scrubbed).toEqual({
      user: { name: '[redacted]', email: '[redacted]', role: 'owner' },
      appointment: { customerPhone: '[redacted]', notes: '[redacted]', id: 'abc' },
    });
  });

  it('recurses into arrays', () => {
    const scrubbed = scrubPhi({
      items: [
        { name: 'x', ok: true },
        { name: 'y', ok: false },
      ],
    }) as { items: Array<{ name: string; ok: boolean }> };
    expect(scrubbed.items[0].name).toBe('[redacted]');
    expect(scrubbed.items[1].ok).toBe(false);
  });

  it('leaves primitives untouched', () => {
    expect(scrubPhi(42)).toBe(42);
    expect(scrubPhi('plain')).toBe('plain');
    expect(scrubPhi(null)).toBe(null);
  });
});

describe('sentryBeforeSend', () => {
  it('scrubs PHI and adds orgId/requestId tags from the request context', () => {
    const event = { message: 'oops', tags: { env: 'prod' }, extra: { email: 'e@x.com' } };
    const out = withRequestContext(
      { requestId: 'req-1', orgId: 'org-42' },
      () => sentryBeforeSend(event),
    ) as { tags: Record<string, string>; extra: { email: string } };
    expect(out.tags.orgId).toBe('org-42');
    expect(out.tags.requestId).toBe('req-1');
    expect(out.tags.env).toBe('prod');
    expect(out.extra.email).toBe('[redacted]');
  });
});

describe('log', () => {
  it('emits a single JSON line with the request context', () => {
    const original = process.stdout.write.bind(process.stdout);
    const lines: string[] = [];
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      lines.push(s);
      return true;
    };
    try {
      withRequestContext({ requestId: 'req-x', orgId: 'org-x' }, () => {
        log.info('hello', { extra: 'field' });
      });
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe('hello');
    expect(parsed.requestId).toBe('req-x');
    expect(parsed.orgId).toBe('org-x');
    expect(parsed.extra).toBe('field');
    expect(parsed.level).toBe('info');
  });
});
