import type { AppLoggerService } from '../core';
import { NoopEmailSender } from './noop-email-sender.adapter';

function makeSender() {
  const warn = jest.fn();
  const sender = new NoopEmailSender({ warn } as unknown as AppLoggerService);
  return { sender, warn };
}

describe('NoopEmailSender', () => {
  it('reports itself disabled so callers never compose a message that cannot go anywhere', () => {
    expect(makeSender().sender.isEnabled()).toBe(false);
  });

  it('throws rather than resolving — a silent success would make an undelivered escalation look delivered', async () => {
    const { sender } = makeSender();

    await expect(
      sender.send({ to: ['admin@example.com'], subject: 'hi', text: 'body' }),
    ).rejects.toThrow(/EMAIL_PROVIDER=none/);
  });

  it('names the env vars that would make it work, so the log tells someone how to fix it', async () => {
    const { sender, warn } = makeSender();

    await sender
      .send({ to: ['admin@example.com'], subject: 'hi', text: 'body' })
      .catch(() => undefined);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('RESEND_API_KEY'),
      'NoopEmailSender',
    );
  });
});
