import type { AppLoggerService } from '../core';
import { LatencyBudgetAlertEventsService } from './latency-budget-alert-events.service';
import type { LatencyBudgetAlert } from './latency-budget-alert.dto';

function makeAlert(
  overrides: Partial<LatencyBudgetAlert> = {},
): LatencyBudgetAlert {
  return {
    tenantId: 'tenant-a',
    p95LatencyMs: 7500,
    budgetMs: 5000,
    windowMinutes: 15,
    sampleSize: 20,
    ...overrides,
  };
}

describe('LatencyBudgetAlertEventsService', () => {
  it('logs a structured warning when an alert fires', () => {
    const warn = jest.fn();
    const service = new LatencyBudgetAlertEventsService({
      warn,
    } as unknown as AppLoggerService);

    service.fire(makeAlert());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('tenant-a'),
      'LatencyBudgetAlertEventsService',
    );
  });

  it('delivers the alert to a subscribed listener', () => {
    const service = new LatencyBudgetAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();
    const alert = makeAlert();

    service.onAlert(listener);
    service.fire(alert);

    expect(listener).toHaveBeenCalledWith(alert);
  });

  it('stops delivering to a listener after offAlert()', () => {
    const service = new LatencyBudgetAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();

    service.onAlert(listener);
    service.offAlert(listener);
    service.fire(makeAlert());

    expect(listener).not.toHaveBeenCalled();
  });
});
