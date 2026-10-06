// F26 (D5, D10): each of the seven gates independently blocks a send, and a
// claim already taken stops a second sender dead.
//
// Every message this path sends is billed and business-initiated, so "did we
// send" is the assertion that matters in every test below — not "did we
// return the right shape".
import type { AppLoggerService } from '../core';
import type { ConversationService } from '../conversation/conversation.service';
import type { CustomerService } from '../customer/customer.service';
import type { NotificationService } from '../notifications/notifications.module';
import type { TemplateSendService } from '../templates/templates.module';
import { DeliveryNotificationService } from './delivery-notification.service';
import type { DeliveryNotificationSettingsService } from './delivery-notification-settings.service';
import type { ShipmentNotificationStore } from './shipment-notification.store';
import type { ShipmentService, ShipmentRecord } from './shipment.service';

const TENANT = 'tenant-a';
const SHIPMENT = 'ship-1';
const TEMPLATE = '22222222-2222-4333-8444-555555555555';

function shipment(overrides: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id: SHIPMENT,
    tenantId: TENANT,
    orderId: 'order-1',
    customerId: 'customer-1',
    courierConnectionId: 'conn-1',
    courier: 'aramex',
    trackingNumber: 'AWB-1',
    currentStatus: 'out_for_delivery',
    currentStatusAt: new Date(),
    estimatedDeliveryAt: null,
    deliveredAt: null,
    lastNotifiedStatus: null,
    lastNotifiedAt: null,
    lastPolledAt: new Date(),
    pollFailureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface HarnessOptions {
  shipment?: ShipmentRecord | null;
  enabled?: boolean;
  statusTemplates?: Record<string, string>;
  prepare?: unknown;
  claimId?: string | null;
  dispatchDelivered?: boolean;
  templateBody?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const shipments = {
    findById: jest
      .fn()
      .mockResolvedValue(
        options.shipment === undefined ? shipment() : options.shipment,
      ),
    markNotified: jest.fn().mockResolvedValue(undefined),
  } as unknown as ShipmentService;

  const settings = {
    get: jest.fn().mockResolvedValue({
      tenantId: TENANT,
      enabled: options.enabled ?? true,
      statusTemplates: options.statusTemplates ?? {
        out_for_delivery: TEMPLATE,
      },
      updatedAt: null,
    }),
  } as unknown as DeliveryNotificationSettingsService;

  const claim = jest
    .fn()
    .mockResolvedValue(
      options.claimId === undefined ? 'claim-1' : options.claimId,
    );
  const settle = jest.fn().mockResolvedValue(undefined);
  const claims = { claim, settle } as unknown as ShipmentNotificationStore;

  const prepare = jest.fn().mockResolvedValue(
    options.prepare ?? {
      ok: true,
      plan: {
        template: {
          id: TEMPLATE,
          name: 'shipment_update',
          language: 'en',
          body: 'Your parcel {{1}} is now {{2}}.',
          category: 'utility',
        },
        text: 'Your parcel AWB-1 is now out for delivery.',
        phoneNumberId: 'pn-1',
      },
    },
  );
  const dispatch = jest
    .fn()
    .mockResolvedValue(
      options.dispatchDelivered === false
        ? { delivered: false, bspMessageId: null, deliveryError: 'BSP 470' }
        : { delivered: true, bspMessageId: 'wamid.X', deliveryError: null },
    );
  const templateSend = { prepare, dispatch } as unknown as TemplateSendService;

  const conversations = {
    getOrCreateConversation: jest.fn().mockResolvedValue({
      id: 'conv-1',
      customerPhone: '+966500000001',
      channel: 'whatsapp',
      channelAccountId: 'pn-1',
    }),
    recordSystemTemplateMessage: jest.fn().mockResolvedValue('message-1'),
    attachOutboundDelivery: jest.fn().mockResolvedValue(undefined),
    markOutboundFailed: jest.fn().mockResolvedValue(undefined),
    startHandover: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationService;

  const customers = {
    getCustomer: jest
      .fn()
      .mockResolvedValue({ id: 'customer-1', phone: '+966500000001' }),
  } as unknown as CustomerService;

  const notifications = {
    record: jest.fn().mockResolvedValue(true),
  } as unknown as NotificationService;

  const service = new DeliveryNotificationService(
    shipments,
    settings,
    claims,
    templateSend,
    conversations,
    customers,
    notifications,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as AppLoggerService,
  );

  return {
    service,
    shipments,
    claims: { claim, settle },
    templateSend: { prepare, dispatch },
    conversations,
    notifications,
  };
}

describe('DeliveryNotificationService — the gates', () => {
  it('sends exactly one template on a clean notifiable transition', async () => {
    const { service, templateSend, claims, conversations } = makeHarness();

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('sent');
    expect(templateSend.dispatch).toHaveBeenCalledTimes(1);
    expect(claims.settle).toHaveBeenCalledWith(
      TENANT,
      'claim-1',
      'sent',
      expect.objectContaining({ templateId: TEMPLATE }),
    );
    // D5: the automated path must leave the conversation with the agent.
    expect(conversations.startHandover).not.toHaveBeenCalled();
  });

  // Gate 1.
  it('does not notify about a status the parcel has already left', async () => {
    const { service, templateSend } = makeHarness({
      shipment: shipment({ currentStatus: 'delivered' }),
    });

    const result = await service.notify(TENANT, SHIPMENT, 'in_transit');

    expect(result.outcome).toBe('stale');
    expect(templateSend.dispatch).not.toHaveBeenCalled();
  });

  // Gate 2. Opt-IN: a tenant who has never opened the screen never sends.
  it('sends nothing when the tenant has not opted in', async () => {
    const { service, templateSend, claims } = makeHarness({ enabled: false });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('skipped_disabled');
    expect(templateSend.prepare).not.toHaveBeenCalled();
    expect(templateSend.dispatch).not.toHaveBeenCalled();
    // Recorded, so the same transition is not re-evaluated every sweep.
    expect(claims.settle).toHaveBeenCalledWith(
      TENANT,
      'claim-1',
      'skipped_disabled',
      expect.anything(),
    );
  });

  // Gate 3.
  it('sends nothing for a status with no mapped template', async () => {
    const { service, templateSend } = makeHarness({ statusTemplates: {} });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('skipped_no_template');
    expect(templateSend.dispatch).not.toHaveBeenCalled();
  });

  // Gate 4a: the category pin. Meta bills and enforces per category, so a
  // marketing template for a shipment update is a policy violation.
  it('pins the utility category on every automated send', async () => {
    const { service, templateSend } = makeHarness();

    await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(templateSend.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ requireCategory: 'utility' }),
    );
  });

  it('records a skip and warns the merchant when the template is unusable', async () => {
    const { service, templateSend, notifications } = makeHarness({
      prepare: {
        ok: false,
        reason: 'wrong_category',
        message: 'This template’s category is "marketing"',
      },
    });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('skipped_no_template');
    expect(templateSend.dispatch).not.toHaveBeenCalled();
    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'shipment_template_unusable' }),
    );
  });

  // Gate 4b: blank-filling would send "Your parcel  is now ." and look fine
  // to the person who configured it.
  it('refuses a template whose placeholder count does not match', async () => {
    const { service, templateSend } = makeHarness({
      prepare: {
        ok: true,
        plan: {
          template: {
            id: TEMPLATE,
            name: 'shipment_update',
            language: 'en',
            body: 'Your parcel {{1}} is now {{2}}, ETA {{3}}.',
            category: 'utility',
          },
          text: 'rendered',
          phoneNumberId: 'pn-1',
        },
      },
    });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('skipped_no_template');
    expect(templateSend.dispatch).not.toHaveBeenCalled();
  });

  // Gate 5.
  it('sends nothing to a customer who opted out', async () => {
    const { service, templateSend, claims, notifications } = makeHarness({
      prepare: {
        ok: false,
        reason: 'opted_out',
        message: 'This customer has opted out of messages.',
      },
    });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('skipped_opt_out');
    expect(templateSend.dispatch).not.toHaveBeenCalled();
    expect(claims.settle).toHaveBeenCalledWith(
      TENANT,
      'claim-1',
      'skipped_opt_out',
      expect.anything(),
    );
    // An opt-out is the customer's decision, not a merchant problem.
    expect(notifications.record).not.toHaveBeenCalled();
  });

  // Gate 6 — the one that makes a duplicate billed template impossible
  // rather than unlikely.
  it('stops without sending when the claim is already held', async () => {
    const { service, templateSend, conversations } = makeHarness({
      claimId: null,
    });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('already_claimed');
    expect(templateSend.dispatch).not.toHaveBeenCalled();
    expect(conversations.recordSystemTemplateMessage).not.toHaveBeenCalled();
  });

  // D10 adversarial: a poll and a webhook observing the same transition at
  // the same instant. Only one INSERT can win, so only one send happens.
  it('lets exactly one of two concurrent notifiers reach the BSP', async () => {
    const claimed = new Set<string>();
    const winners: string[] = [];

    const run = async (label: string) => {
      const { service, templateSend, claims } = makeHarness();
      claims.claim.mockImplementation((_t: string, s: string, st: string) => {
        const key = `${s}:${st}`;
        if (claimed.has(key)) return Promise.resolve(null);
        claimed.add(key);
        return Promise.resolve(`claim-${label}`);
      });
      const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');
      if (result.outcome === 'sent') winners.push(label);
      return templateSend.dispatch.mock.calls.length;
    };

    const [pollSends, webhookSends] = await Promise.all([
      run('poll'),
      run('webhook'),
    ]);

    expect(winners).toHaveLength(1);
    expect(pollSends + webhookSends).toBe(1);
  });

  // Gate 7's failure half: the claim is already held, so a retry cannot
  // double-send a send that actually succeeded.
  it('marks the claim failed and the message failed when the BSP rejects', async () => {
    const { service, claims, conversations } = makeHarness({
      dispatchDelivered: false,
    });

    const result = await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(result.outcome).toBe('failed');
    expect(conversations.markOutboundFailed).toHaveBeenCalled();
    expect(claims.settle).toHaveBeenCalledWith(
      TENANT,
      'claim-1',
      'failed',
      expect.objectContaining({ detail: 'BSP 470' }),
    );
  });

  it('records the message with a deterministic client id as a second barrier', async () => {
    const { service, conversations } = makeHarness();

    await service.notify(TENANT, SHIPMENT, 'out_for_delivery');

    expect(conversations.recordSystemTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: `shipment:${SHIPMENT}:out_for_delivery`,
      }),
    );
  });

  it('is a no-op for a shipment that does not exist in this tenant', async () => {
    const { service, templateSend } = makeHarness({ shipment: null });

    const result = await service.notify(TENANT, SHIPMENT, 'delivered');

    expect(result.outcome).toBe('not_found');
    expect(templateSend.prepare).not.toHaveBeenCalled();
  });
});
