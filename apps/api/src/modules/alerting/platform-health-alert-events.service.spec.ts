import type { AppLoggerService } from '../core';
import { PlatformHealthAlertEventsService } from './platform-health-alert-events.service';
import type { PlatformHealthAlert } from './platform-health-alert.dto';

function makeAlert(
  overrides: Partial<PlatformHealthAlert> = {},
): PlatformHealthAlert {
  return {
    type: 'circuit_breaker_open',
    message: 'LLM circuit breaker is open.',
    details: { state: 'open' },
    ...overrides,
  };
}

describe('PlatformHealthAlertEventsService', () => {
  it('logs a structured warning when an alert fires', () => {
    const warn = jest.fn();
    const service = new PlatformHealthAlertEventsService({
      warn,
    } as unknown as AppLoggerService);

    service.fire(makeAlert());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('circuit_breaker_open'),
      'PlatformHealthAlertEventsService',
    );
  });

  it('delivers the alert to a subscribed listener', () => {
    const service = new PlatformHealthAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();
    const alert = makeAlert();

    service.onAlert(listener);
    service.fire(alert);

    expect(listener).toHaveBeenCalledWith(alert);
  });

  it('stops delivering to a listener after offAlert()', () => {
    const service = new PlatformHealthAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();

    service.onAlert(listener);
    service.offAlert(listener);
    service.fire(makeAlert());

    expect(listener).not.toHaveBeenCalled();
  });
});
