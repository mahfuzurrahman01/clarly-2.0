import type { AppLoggerService } from '../core';
import { StuckTicketAlertEventsService } from './stuck-ticket-alert-events.service';
import type { StuckTicketAlert } from './stuck-ticket-alert.dto';

function makeAlert(
  overrides: Partial<StuckTicketAlert> = {},
): StuckTicketAlert {
  return {
    tenantId: 'tenant-a',
    ticketId: 'ticket-1',
    customerId: 'customer-1',
    createdAt: new Date('2026-08-13T11:40:00Z'),
    unclaimedMinutes: 20,
    thresholdMinutes: 15,
    ...overrides,
  };
}

describe('StuckTicketAlertEventsService', () => {
  it('logs a structured warning when an alert fires', () => {
    const warn = jest.fn();
    const service = new StuckTicketAlertEventsService({
      warn,
    } as unknown as AppLoggerService);

    service.fire(makeAlert());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ticket-1'),
      'StuckTicketAlertEventsService',
    );
  });

  it('delivers the alert to a subscribed listener', () => {
    const service = new StuckTicketAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();
    const alert = makeAlert();

    service.onAlert(listener);
    service.fire(alert);

    expect(listener).toHaveBeenCalledWith(alert);
  });

  it('stops delivering to a listener after offAlert()', () => {
    const service = new StuckTicketAlertEventsService({
      warn: jest.fn(),
    } as unknown as AppLoggerService);
    const listener = jest.fn();

    service.onAlert(listener);
    service.offAlert(listener);
    service.fire(makeAlert());

    expect(listener).not.toHaveBeenCalled();
  });
});
