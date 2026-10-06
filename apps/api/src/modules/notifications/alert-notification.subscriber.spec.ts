import type { AppLoggerService } from '../core';
import type { LatencyBudgetAlertEventsService } from '../alerting/latency-budget-alert-events.service';
import type { StuckTicketAlertEventsService } from '../alerting/stuck-ticket-alert-events.service';
import type { ToolScopeViolationAlertEventsService } from '../alerting/tool-scope-violation-alert-events.service';
import type { StuckTicketAlert } from '../alerting/stuck-ticket-alert.dto';
import type { AlertEmailService } from './alert-email.service';
import { AlertNotificationSubscriber } from './alert-notification.subscriber';
import type { NotificationService } from './notification.service';

const TENANT_A = 'tenant-a';
const TICKET_ID = 'ticket-1';

function stuckTicketAlert(
  overrides: Partial<StuckTicketAlert> = {},
): StuckTicketAlert {
  return {
    tenantId: TENANT_A,
    ticketId: TICKET_ID,
    customerId: 'customer-1',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    unclaimedMinutes: 42,
    thresholdMinutes: 15,
    ...overrides,
  };
}

/** Real EventEmitter-shaped fakes: the whole point of this class is that it actually subscribes, so the test drives it through the same on/off surface the alert services expose. */
function makeHarness() {
  const listeners: Record<string, ((alert: never) => void)[]> = {
    stuck: [],
    latency: [],
    toolScope: [],
  };

  const eventService = (key: keyof typeof listeners) =>
    ({
      onAlert: (listener: (alert: never) => void) =>
        listeners[key].push(listener),
      offAlert: (listener: (alert: never) => void) => {
        listeners[key] = listeners[key].filter((item) => item !== listener);
      },
    }) as unknown as never;

  const record = jest.fn().mockResolvedValue(true);
  const error = jest.fn();
  const sendCriticalAlert = jest.fn().mockResolvedValue(true);

  const subscriber = new AlertNotificationSubscriber(
    { record } as unknown as NotificationService,
    { sendCriticalAlert } as unknown as AlertEmailService,
    eventService('stuck'),
    eventService('latency'),
    eventService('toolScope'),
    { error } as unknown as AppLoggerService,
  );

  return {
    subscriber,
    record,
    error,
    sendCriticalAlert,
    fireStuck: (alert: StuckTicketAlert) =>
      listeners.stuck.forEach((listener) => listener(alert as never)),
    listeners,
  };
}

describe('AlertNotificationSubscriber', () => {
  it('records a notification when a ticket goes unclaimed — the alert had no consumer at all before this', async () => {
    const { subscriber, record, fireStuck } = makeHarness();
    subscriber.onModuleInit();

    fireStuck(stuckTicketAlert());
    await Promise.resolve();

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        kind: 'ticket_stuck',
        severity: 'critical',
        entityType: 'ticket',
        entityId: TICKET_ID,
      }),
    );
  });

  it('keys the stuck-ticket notification by ticket, so a sweep that re-fires every few minutes produces one row', async () => {
    const { subscriber, record, fireStuck } = makeHarness();
    subscriber.onModuleInit();

    fireStuck(stuckTicketAlert({ unclaimedMinutes: 20 }));
    fireStuck(stuckTicketAlert({ unclaimedMinutes: 25 }));
    await Promise.resolve();

    const keys = record.mock.calls.map(
      ([input]: [{ dedupKey: string }]) => input.dedupKey,
    );
    expect(keys).toEqual([
      `ticket_stuck:${TICKET_ID}`,
      `ticket_stuck:${TICKET_ID}`,
    ]);
    // Same key both times — the database's unique constraint is what makes
    // the second one a no-op, and this is the value it depends on.
  });

  it('writes the customer-facing wording, not the log line', async () => {
    const { subscriber, record, fireStuck } = makeHarness();
    subscriber.onModuleInit();

    fireStuck(stuckTicketAlert());
    await Promise.resolve();

    const [input] = record.mock.calls[0] as [{ title: string; body: string }];
    expect(input.title).toContain('42 minutes');
    expect(input.body).toContain('15 minutes');
    // No internal identifiers leak into what a tenant reads.
    expect(input.body).not.toContain(TICKET_ID);
  });

  it('records the interpolated values as params so the console can localise the notification', async () => {
    const { subscriber, record, fireStuck } = makeHarness();
    subscriber.onModuleInit();

    fireStuck(stuckTicketAlert());
    await Promise.resolve();

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ticket_stuck',
        params: { minutes: 42, thresholdMinutes: 15 },
      }),
    );
  });

  it('never lets a write failure escape into the sweep that fired the alert', async () => {
    const { subscriber, record, error, fireStuck } = makeHarness();
    record.mockRejectedValue(new Error('database is down'));
    subscriber.onModuleInit();

    expect(() => fireStuck(stuckTicketAlert())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toHaveBeenCalled();
  });

  it('unsubscribes on shutdown so a restarted module does not double-record', () => {
    const { subscriber, listeners } = makeHarness();
    subscriber.onModuleInit();
    expect(listeners.stuck).toHaveLength(1);

    subscriber.onModuleDestroy();

    expect(listeners.stuck).toHaveLength(0);
    expect(listeners.latency).toHaveLength(0);
    expect(listeners.toolScope).toHaveLength(0);
  });
  it('emails the tenant admins when a ticket escalation goes unclaimed — a notification row is only seen by someone already looking', async () => {
    const { subscriber, sendCriticalAlert, fireStuck } = makeHarness();
    subscriber.onModuleInit();

    fireStuck(stuckTicketAlert());
    await Promise.resolve();
    await Promise.resolve();

    expect(sendCriticalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        entityType: 'ticket',
        entityId: TICKET_ID,
      }),
    );
  });

  it('does not email again when the write was deduped — the stuck-ticket sweep re-fires for the same ticket on every run until someone claims it', async () => {
    const { subscriber, record, sendCriticalAlert, fireStuck } = makeHarness();
    record.mockResolvedValue(false);
    subscriber.onModuleInit();

    fireStuck(stuckTicketAlert());
    await Promise.resolve();
    await Promise.resolve();

    expect(sendCriticalAlert).not.toHaveBeenCalled();
  });
});
