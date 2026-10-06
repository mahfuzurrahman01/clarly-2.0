import type { AppLoggerService } from '../core';
import { ToolScopeViolationAlertEventsService } from './tool-scope-violation-alert-events.service';
import type { ToolScopeViolationAlert } from './tool-scope-violation-alert.dto';

function makeAlert(
  overrides: Partial<ToolScopeViolationAlert> = {},
): ToolScopeViolationAlert {
  return {
    tenantId: 'tenant-a',
    violationCount: 5,
    threshold: 3,
    windowMinutes: 5,
    ...overrides,
  };
}

describe('ToolScopeViolationAlertEventsService', () => {
  it('logs a structured warning when an alert fires', () => {
    const warn = jest.fn();
    const service = new ToolScopeViolationAlertEventsService({
      warn,
    } as unknown as AppLoggerService);

    service.fire(makeAlert());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('tenant-a'),
      'ToolScopeViolationAlertEventsService',
    );
  });

  it('delivers the alert to a subscribed listener', () => {
    const service = new ToolScopeViolationAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();
    const alert = makeAlert();

    service.onAlert(listener);
    service.fire(alert);

    expect(listener).toHaveBeenCalledWith(alert);
  });

  it('stops delivering to a listener after offAlert()', () => {
    const service = new ToolScopeViolationAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();

    service.onAlert(listener);
    service.offAlert(listener);
    service.fire(makeAlert());

    expect(listener).not.toHaveBeenCalled();
  });
});
