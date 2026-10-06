// F26 (Delivery Tracking): the J&T push callback (D6).
//
// THE ORDER OF OPERATIONS IS THE SECURITY CONTRACT. All three of the first
// steps were broken or absent in F24, and each one is here for a specific
// failure that produced:
//
//   1. Reject unknown couriers and POLL-ONLY couriers up front.
//      `webhookSignatureHeader === null` ⇒ 401. Aramex's unsigned enterprise
//      push is therefore not accepted by accident.
//   2. Resolve the connection from (courier, account_ref) — the routing key,
//      via an admin read with an explicit `is_active` predicate. NOTHING IN
//      THE BODY CHOOSES A TENANT. An unknown connection returns the same
//      generic 401 as a bad signature, so an attacker cannot enumerate which
//      merchants use which courier.
//   3. Verify the digest against the decrypted per-connection
//      `webhook_secret`, read from the courier's REAL header name — the
//      adapter owns the header name, because F24 read one invented
//      `x-webhook-signature` for all three providers and so never verified
//      anything. Missing secret or missing header ⇒ 401. Never "process
//      unverified".
//   4. CLAIM in `courier_webhook_events` before any work.
//   5. Apply through the same `applyStatusEvents()` the poller uses.
//
// 200 on a successfully claimed event (couriers retry aggressively on
// non-2xx); 401 only for signature/routing failures.
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { CourierConnectionService } from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import { CourierWebhookEventStore } from './courier-webhook-event.store';
import { DeliveryNotificationQueueService } from './delivery-notification.queue-service';
import { ShipmentService } from './shipment.service';
import { isCourierName } from './ports/courier-connector.port';
import type { CourierWebhookHeaders } from './ports/courier-connector.port';

export interface CourierWebhookOutcome {
  received: true;
  duplicate?: boolean;
}

/**
 * One message for every rejection. A specific one ("no such account",
 * "signature mismatch") is an oracle: it tells an unauthenticated caller
 * which merchants exist and which courier they use.
 */
const GENERIC_REJECTION = 'Invalid webhook signature';

@Injectable()
export class CourierWebhookService {
  constructor(
    private readonly connections: CourierConnectionService,
    private readonly registry: CourierConnectorRegistry,
    private readonly events: CourierWebhookEventStore,
    private readonly shipments: ShipmentService,
    private readonly notificationQueue: DeliveryNotificationQueueService,
    private readonly logger: AppLoggerService,
  ) {}

  async handleWebhook(
    courier: string,
    accountRef: string,
    rawBody: Buffer | undefined,
    headers: CourierWebhookHeaders,
  ): Promise<CourierWebhookOutcome> {
    // Step 1. An unknown courier name resolves to the no-op adapter, whose
    // `webhookSignatureHeader` is also null — so both cases fall out here.
    const connector = this.registry.forCourier(courier);
    const signatureHeader = connector.webhookSignatureHeader;
    if (!isCourierName(courier) || signatureHeader === null) {
      this.reject(`push is not accepted for courier "${courier}"`);
    }

    if (!rawBody || rawBody.length === 0) {
      // A digest is over exact bytes. No bytes, nothing to verify.
      this.reject(`empty body on ${courier}/${accountRef}`);
    }

    // Step 2. The routing key, and the ONLY thing that decides the tenant.
    const connection = await this.connections.findByRoutingKey(
      courier,
      accountRef,
    );
    if (!connection || !connection.webhookSecret) {
      this.reject(
        `no active connection with a webhook secret for ${courier}/${accountRef}`,
      );
    }

    // Step 3.
    const signature = headers[signatureHeader];
    if (
      !signature ||
      !connector.verifyWebhookSignature(
        rawBody,
        signature,
        connection.webhookSecret,
      )
    ) {
      this.reject(`signature check failed for ${courier}/${accountRef}`);
    }

    const payload = parseJson(rawBody);

    // Step 4. Claim before any work. A replayed body produces the same event
    // id, loses the claim, and is answered with a 200 that did nothing.
    const eventId = connector.extractEventId(payload, headers);
    if (!eventId) {
      // Verified, but unusable. Claimed nothing, changed nothing, and 200 so
      // the courier stops retrying something we will never process.
      this.logger.warn(
        `${courier}/${accountRef}: verified callback carried no usable event id — ignored`,
        'CourierWebhookService',
      );
      return { received: true };
    }

    const claimId = await this.events.claim({
      courier,
      accountRef,
      eventId,
      eventType: 'tracking_update',
      payload: asRecord(payload),
    });
    if (!claimId) return { received: true, duplicate: true };

    try {
      await this.apply(connection.tenantId, courier, payload, headers, claimId);
    } catch (error) {
      await this.events.markStatus(claimId, 'failed');
      this.logger.error(
        `${courier}/${accountRef}: applying a verified callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'CourierWebhookService',
      );
    }

    return { received: true };
  }

  private async apply(
    tenantId: string,
    courier: string,
    payload: unknown,
    headers: CourierWebhookHeaders,
    claimId: string,
  ): Promise<void> {
    const connector = this.registry.forCourier(courier);
    const normalized = connector.normalizeWebhookEvent(payload, headers);
    if (!normalized) {
      await this.events.markStatus(claimId, 'ignored');
      return;
    }

    // A callback for a waybill we do not track is not an error (D8): the
    // merchant may create labels we never saw. Claim, mark ignored, 200.
    const shipment = await this.shipments.findByTrackingNumber(
      tenantId,
      connector.courier,
      normalized.trackingNumber,
    );
    if (!shipment) {
      await this.events.markStatus(claimId, 'ignored');
      return;
    }

    // The same convergence point the poller uses — one place decides "the
    // status changed" and therefore one place decides "notify".
    const applied = await this.shipments.applyStatusEvents(
      tenantId,
      shipment.id,
      normalized.events,
      'webhook',
    );
    if (applied?.notifiableTransition) {
      await this.notificationQueue.enqueue(
        tenantId,
        shipment.id,
        applied.currentStatus,
      );
    }
    await this.events.markStatus(claimId, 'processed');
  }

  /** Logged as a security event, answered generically. */
  private reject(detail: string): never {
    this.logger.warn(
      `courier webhook rejected: ${detail}`,
      'CourierWebhookService',
    );
    throw new UnauthorizedException(GENERIC_REJECTION);
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    // The signature already passed, so this is a courier sending something
    // other than JSON — recorded as "nothing we can normalize", not as an
    // authentication problem.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { payload: value };
}
