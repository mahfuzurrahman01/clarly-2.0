import type { AppConfigService, AppLoggerService } from '../core';
import type { PlatformHealthAlertEventsService } from '../alerting/platform-health-alert-events.service';
import type { PlatformHealthAlert } from '../alerting/platform-health-alert.dto';
import type { EmailSender } from '../email/ports/email-sender.port';

const captureMessage: jest.Mock = jest.fn();
jest.mock('@sentry/nestjs', () => ({
  captureMessage: (...args: unknown[]): void => {
    captureMessage(...args);
  },
}));

// Imported after the mock so the subscriber picks up the faked SDK.
import { PlatformHealthPagingSubscriber } from './platform-health-paging.subscriber';

function alert(
  overrides: Partial<PlatformHealthAlert> = {},
): PlatformHealthAlert {
  return {
    type: 'circuit_breaker_open',
    message: 'LLM circuit breaker is open.',
    details: { state: 'open' },
    ...overrides,
  };
}

/** Real EventEmitter-shaped fake, matching the on/off surface the alert service exposes — same pattern as alert-notification.subscriber.spec.ts. */
function makeHarness(opts: {
  sentryDsn?: string;
  platformAlertEmail?: string;
  emailEnabled?: boolean;
  send?: jest.Mock;
}) {
  const listeners: ((alert: PlatformHealthAlert) => void)[] = [];
  const alertEvents = {
    onAlert: (listener: (alert: PlatformHealthAlert) => void) =>
      listeners.push(listener),
    offAlert: (listener: (alert: PlatformHealthAlert) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  } as unknown as PlatformHealthAlertEventsService;

  const send: jest.Mock =
    opts.send ?? jest.fn().mockResolvedValue({ providerMessageId: null });
  const email = {
    isEnabled: () => opts.emailEnabled ?? true,
    send,
  } as unknown as EmailSender;

  const config = {
    sentryDsn: opts.sentryDsn,
    platformAlertEmail: opts.platformAlertEmail,
  } as unknown as AppConfigService;

  const log = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  const debug = jest.fn();
  const logger = { log, warn, error, debug } as unknown as AppLoggerService;

  const subscriber = new PlatformHealthPagingSubscriber(
    alertEvents,
    email,
    config,
    logger,
  );

  return {
    subscriber,
    send,
    logError: error,
    fire: (a: PlatformHealthAlert) =>
      listeners.forEach((listener) => listener(a)),
  };
}

describe('PlatformHealthPagingSubscriber', () => {
  beforeEach(() => {
    captureMessage.mockReset();
  });

  it('pages Sentry with the alert as extra context when SENTRY_DSN is configured', () => {
    const { subscriber, fire } = makeHarness({
      sentryDsn: 'https://x@o0.ingest.sentry.io/0',
    });
    subscriber.onModuleInit();

    fire(alert());

    expect(captureMessage).toHaveBeenCalledWith(
      '[platform-health] LLM circuit breaker is open.',
      expect.objectContaining({
        level: 'error',
        tags: { alertType: 'circuit_breaker_open' },
        extra: { state: 'open' },
      }),
    );
  });

  it('does not call Sentry when SENTRY_DSN is unset', () => {
    const { subscriber, fire } = makeHarness({});
    subscriber.onModuleInit();

    fire(alert());

    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('emails PLATFORM_ALERT_EMAIL when configured and the mail provider is enabled', async () => {
    const { subscriber, fire, send } = makeHarness({
      platformAlertEmail: 'ops@example.com',
    });
    subscriber.onModuleInit();

    fire(
      alert({
        message: 'Postgres is unreachable.',
        details: { dependency: 'postgres' },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0] as [
      { to: string[]; subject: string; text: string },
    ];
    expect(message.to).toEqual(['ops@example.com']);
    expect(message.subject).toBe('[Clarly platform] Postgres is unreachable.');
    expect(message.text).toContain('dependency: postgres');
  });

  it('does not email when PLATFORM_ALERT_EMAIL is unset', async () => {
    const { subscriber, fire, send } = makeHarness({});
    subscriber.onModuleInit();

    fire(alert());
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
  });

  it('does not email when no mail provider is configured, even with an address set', async () => {
    const { subscriber, fire, send } = makeHarness({
      platformAlertEmail: 'ops@example.com',
      emailEnabled: false,
    });
    subscriber.onModuleInit();

    fire(alert());
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
  });

  it('logs, and does not throw, when the mail provider rejects', async () => {
    const send = jest.fn().mockRejectedValue(new Error('smtp down'));
    const { subscriber, fire, logError } = makeHarness({
      platformAlertEmail: 'ops@example.com',
      send,
    });
    subscriber.onModuleInit();

    expect(() => fire(alert())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('smtp down'),
      'PlatformHealthPagingSubscriber',
    );
  });

  it('stops paging once unsubscribed via onModuleDestroy', () => {
    const { subscriber, fire } = makeHarness({
      sentryDsn: 'https://x@o0.ingest.sentry.io/0',
    });
    subscriber.onModuleInit();
    subscriber.onModuleDestroy();

    fire(alert());

    expect(captureMessage).not.toHaveBeenCalled();
  });
});
