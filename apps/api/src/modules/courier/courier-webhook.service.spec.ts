// F26 (D6, D10): the J&T push callback.
//
// Every test here maps to one of F24's six P1s or to the order-of-operations
// contract written to prevent them: reject poll-only couriers, route from the
// URL and never from the body, verify against the courier's OWN header name,
// claim before any work, and answer every rejection with the same generic
// 401 so the endpoint is not an enumeration oracle.
import { UnauthorizedException } from '@nestjs/common';
import type { AppLoggerService } from '../core';
import type { CourierConnectionService } from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import type { CourierWebhookEventStore } from './courier-webhook-event.store';
import { CourierWebhookService } from './courier-webhook.service';
import type { DeliveryNotificationQueueService } from './delivery-notification.queue-service';
import type { ShipmentService } from './shipment.service';
import { AramexConnector } from './ports/aramex.connector';
import { JtConnector } from './ports/jt.connector';
import { NaqelConnector } from './ports/naqel.connector';
import { NoopCourierConnector } from './ports/noop-courier.connector';
import { SmsaConnector } from './ports/smsa.connector';
import {
  JT_WEBHOOK_BODY,
  JT_WEBHOOK_BODY_WITH_TENANT_CLAIM,
} from './ports/__fixtures__/courier-responses';

const TENANT = 'tenant-a';
const SECRET = 'whsec-jt';
const ACCOUNT_REF = 'JT-ACCOUNT-1';

function logger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function signed(body: unknown, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    raw,
    headers: { digest: JtConnector.digest(raw.toString('utf8'), secret) },
  };
}

interface HarnessOptions {
  connection?: unknown;
  claimId?: string | null;
  shipment?: unknown;
  applied?: unknown;
}

function makeHarness(options: HarnessOptions = {}) {
  const registry = new CourierConnectorRegistry(
    new AramexConnector(),
    new SmsaConnector(),
    new NaqelConnector(),
    new JtConnector(),
    new NoopCourierConnector(logger()),
  );

  const findByRoutingKey = jest.fn().mockResolvedValue(
    options.connection === undefined
      ? {
          id: 'conn-1',
          tenantId: TENANT,
          courier: 'jt',
          accountRef: ACCOUNT_REF,
          credentials: {},
          webhookSecret: SECRET,
          isActive: true,
        }
      : options.connection,
  );

  const claim = jest
    .fn()
    .mockResolvedValue(
      options.claimId === undefined ? 'evt-1' : options.claimId,
    );
  const markStatus = jest.fn().mockResolvedValue(undefined);

  const findByTrackingNumber = jest
    .fn()
    .mockResolvedValue(
      options.shipment === undefined
        ? { id: 'ship-1', tenantId: TENANT }
        : options.shipment,
    );
  const applyStatusEvents = jest.fn().mockResolvedValue(
    options.applied ?? {
      shipmentId: 'ship-1',
      newEventCount: 1,
      previousStatus: 'out_for_delivery',
      currentStatus: 'delivered',
      notifiableTransition: true,
    },
  );

  const enqueue = jest.fn().mockResolvedValue(undefined);

  const service = new CourierWebhookService(
    { findByRoutingKey } as unknown as CourierConnectionService,
    registry,
    { claim, markStatus } as unknown as CourierWebhookEventStore,
    {
      findByTrackingNumber,
      applyStatusEvents,
    } as unknown as ShipmentService,
    { enqueue } as unknown as DeliveryNotificationQueueService,
    logger(),
  );

  return {
    service,
    findByRoutingKey,
    claim,
    markStatus,
    findByTrackingNumber,
    applyStatusEvents,
    enqueue,
  };
}

describe('CourierWebhookService — step 1: which couriers we accept push from', () => {
  // D1: Aramex's enterprise push is account-provisioned with no documented
  // signature scheme, so it is refused BEFORE anything else runs — not
  // accepted by accident because a route existed.
  it.each(['aramex', 'smsa', 'naqel'])(
    'rejects %s, which is poll-only',
    async (courier) => {
      const { service, findByRoutingKey } = makeHarness();
      const { raw, headers } = signed(JT_WEBHOOK_BODY);

      await expect(
        service.handleWebhook(courier, ACCOUNT_REF, raw, headers),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Not even a routing lookup: nothing about the request is trusted.
      expect(findByRoutingKey).not.toHaveBeenCalled();
    },
  );

  it('rejects a courier name it does not know', async () => {
    const { service } = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    await expect(
      service.handleWebhook('dhl', ACCOUNT_REF, raw, headers),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an empty body — a digest is over exact bytes', async () => {
    const { service } = makeHarness();

    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, Buffer.alloc(0), {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, undefined, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CourierWebhookService — step 2: routing', () => {
  it('resolves the tenant from (courier, account_ref) only', async () => {
    const { service, findByRoutingKey, applyStatusEvents } = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY_WITH_TENANT_CLAIM);

    await service.handleWebhook('jt', ACCOUNT_REF, raw, headers);

    expect(findByRoutingKey).toHaveBeenCalledWith('jt', ACCOUNT_REF);
    // D10 adversarial: the body's `tenant_id` is never read.
    expect(applyStatusEvents).toHaveBeenCalledWith(
      TENANT,
      'ship-1',
      expect.anything(),
      'webhook',
    );
  });

  // The generic message is deliberate: a specific one would tell an
  // unauthenticated caller which merchants exist and which courier they use.
  it('answers an unknown routing key with the same 401 as a bad signature', async () => {
    const unknown = makeHarness({ connection: null });
    const forged = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    const unknownError = await unknown.service
      .handleWebhook('jt', 'NOT-A-REAL-ACCOUNT', raw, headers)
      .catch((error: Error) => error);
    const forgedError = await forged.service
      .handleWebhook('jt', ACCOUNT_REF, raw, { digest: 'forged' })
      .catch((error: Error) => error);

    expect(unknownError).toBeInstanceOf(UnauthorizedException);
    expect(forgedError).toBeInstanceOf(UnauthorizedException);
    expect((unknownError as Error).message).toBe(
      (forgedError as Error).message,
    );
  });

  it('refuses a connection that has no webhook secret', async () => {
    const { service } = makeHarness({
      connection: {
        id: 'conn-1',
        tenantId: TENANT,
        courier: 'jt',
        accountRef: ACCOUNT_REF,
        credentials: {},
        webhookSecret: null,
        isActive: true,
      },
    });
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, raw, headers),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CourierWebhookService — step 3: verification', () => {
  it('accepts a correctly signed callback', async () => {
    const { service, applyStatusEvents, markStatus } = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    const outcome = await service.handleWebhook(
      'jt',
      ACCOUNT_REF,
      raw,
      headers,
    );

    expect(outcome).toEqual({ received: true });
    expect(applyStatusEvents).toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith('evt-1', 'processed');
  });

  it('rejects a forged digest without touching the claim log', async () => {
    const { service, claim } = makeHarness();
    const { raw } = signed(JT_WEBHOOK_BODY);

    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, raw, { digest: 'forged' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects a digest computed with the wrong secret', async () => {
    const { service } = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY, 'someone-elses-secret');

    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, raw, headers),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // F24 read an invented `x-webhook-signature` for all three providers, so
  // verification never actually ran. The adapter owns the header name.
  it('rejects when the courier’s own header is missing', async () => {
    const { service } = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, raw, {
        'x-webhook-signature': headers.digest,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a body whose bytes changed after signing', async () => {
    const { service } = makeHarness();
    const { headers } = signed(JT_WEBHOOK_BODY);
    const tampered = Buffer.from(
      JSON.stringify({ ...JT_WEBHOOK_BODY, extra: true }),
      'utf8',
    );

    await expect(
      service.handleWebhook('jt', ACCOUNT_REF, tampered, headers),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CourierWebhookService — step 4/5: claim and apply', () => {
  // Couriers retry aggressively; a replayed body must be a no-op, not a
  // second status application and certainly not a second billed template.
  it('answers a replayed callback with duplicate:true and does no work', async () => {
    const { service, applyStatusEvents } = makeHarness({ claimId: null });
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    const outcome = await service.handleWebhook(
      'jt',
      ACCOUNT_REF,
      raw,
      headers,
    );

    expect(outcome).toEqual({ received: true, duplicate: true });
    expect(applyStatusEvents).not.toHaveBeenCalled();
  });

  // D8: a shipment we do not know about is not an error.
  it('claims, ignores and returns 200 for an unknown tracking number', async () => {
    const { service, markStatus, applyStatusEvents } = makeHarness({
      shipment: null,
    });
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    const outcome = await service.handleWebhook(
      'jt',
      ACCOUNT_REF,
      raw,
      headers,
    );

    expect(outcome).toEqual({ received: true });
    expect(applyStatusEvents).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith('evt-1', 'ignored');
  });

  it('enqueues a notification for a notifiable transition', async () => {
    const { service, enqueue } = makeHarness();
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    await service.handleWebhook('jt', ACCOUNT_REF, raw, headers);

    expect(enqueue).toHaveBeenCalledWith(TENANT, 'ship-1', 'delivered');
  });

  it('enqueues nothing when the status did not move forward', async () => {
    const { service, enqueue } = makeHarness({
      applied: {
        shipmentId: 'ship-1',
        newEventCount: 0,
        previousStatus: 'delivered',
        currentStatus: 'delivered',
        notifiableTransition: false,
      },
    });
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    await service.handleWebhook('jt', ACCOUNT_REF, raw, headers);

    expect(enqueue).not.toHaveBeenCalled();
  });

  // A courier that keeps retrying a callback we cannot apply is worse than
  // one that stops: the claim is marked failed and the 200 still goes back.
  it('marks the claim failed and still answers 200 when applying throws', async () => {
    const { service, applyStatusEvents, markStatus } = makeHarness();
    applyStatusEvents.mockRejectedValue(new Error('db down'));
    const { raw, headers } = signed(JT_WEBHOOK_BODY);

    const outcome = await service.handleWebhook(
      'jt',
      ACCOUNT_REF,
      raw,
      headers,
    );

    expect(outcome).toEqual({ received: true });
    expect(markStatus).toHaveBeenCalledWith('evt-1', 'failed');
  });
});
