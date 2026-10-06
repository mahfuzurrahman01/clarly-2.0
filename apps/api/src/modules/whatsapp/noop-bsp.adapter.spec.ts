import type { AppLoggerService } from '../core';
import { BspNotConfiguredError, NoopBspAdapter } from './noop-bsp.adapter';

describe('NoopBspAdapter', () => {
  const warn = jest.fn();
  const logger = { warn } as unknown as AppLoggerService;
  const adapter = new NoopBspAdapter(logger);

  beforeEach(() => warn.mockReset());

  it('fails signature verification closed, so an unconfigured webhook endpoint accepts nothing', () => {
    expect(adapter.verifyWebhookSignature()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('parses to zero messages (unreachable — ingest rejects on the failed signature first)', () => {
    expect(adapter.parseInboundWebhook()).toEqual([]);
  });

  it('throws on send rather than silently dropping a reply the turn recorded as answered', async () => {
    await expect(
      adapter.sendTextMessage({
        phoneNumberId: 'P1',
        to: '155',
        body: 'hello',
      }),
    ).rejects.toBeInstanceOf(BspNotConfiguredError);
  });

  it('logs what it would have sent, without logging the message body', async () => {
    await expect(
      adapter.sendTextMessage({
        phoneNumberId: 'P1',
        to: '155',
        body: 'customer PII in here',
      }),
    ).rejects.toThrow();

    const logged = warn.mock.calls.map(([message]) => String(message)).join('');
    expect(logged).not.toContain('customer PII in here');
    expect(logged).toContain('P1');
  });
});
