// F26 (Delivery Tracking): turns a status transition into exactly one
// approved utility template — or into a recorded reason why not (D5).
//
// The seven gates, in this order and no other:
//   1. Forward-only transition (decided upstream in
//      `ShipmentService.applyStatusEvents`; re-checked here as a terminal
//      guard because a job can be retried long after the fact).
//   2. Tenant opt-in (`delivery_notification_settings.enabled`, default
//      false — every message here is billed and business-initiated).
//   3. Notifiable set: a status with no template mapping is never notified.
//   4. Template resolution: whatsapp_template + utility + approved, with a
//      matching placeholder count.
//   5. Consent: `CustomerConsentService.isOptedOut`.
//   6. CLAIM: insert (shipment_id, status). No row ⇒ someone already
//      claimed this transition ⇒ STOP. The unique index is the lock.
//   7. Send, then settle the claim `sent` / `failed`.
//
// Gate 6 is deliberately AFTER the cheap gates and BEFORE the send: a skip is
// recorded as a claim outcome, so the same transition is never re-evaluated
// (and the merchant never re-nagged about the same missing template), and no
// two workers can both reach the BSP.
//
// The send itself goes through the shared `TemplateSendService`, not a second
// copy of the approval/consent logic — that is D5's "the send path is shared,
// not copied". What this path does NOT share with the human path: it records
// the message as `role: 'assistant'` with no author, and it never calls
// `startHandover()`. A shipment notification must leave the conversation with
// the agent.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { ConversationService } from '../conversation/conversation.service';
import { CustomerService } from '../customer/customer.service';
import { NotificationService } from '../notifications/notification-record.module';
import { notificationContent } from '../notifications/notification-content';
import { TemplateSendService } from '../templates/templates.module';
import { templatePositions } from '../templates/template-body';
import { DeliveryNotificationSettingsService } from './delivery-notification-settings.service';
import { ShipmentNotificationStore } from './shipment-notification.store';
import { ShipmentService } from './shipment.service';
import {
  isForwardTransition,
  type ShipmentStatus,
} from './ports/courier-connector.port';
import type { ShipmentNotificationOutcome } from '../persistence/drizzle/schema';

/** What one notification attempt did. Returned rather than logged-and-void so the processor and the tests can assert on it. */
export interface DeliveryNotificationOutcome {
  outcome:
    | ShipmentNotificationOutcome
    | 'already_claimed'
    | 'not_found'
    /** The parcel moved past this status before the job ran. Not claimed: the transition itself was never decided against. */
    | 'stale';
  detail?: string;
}

@Injectable()
export class DeliveryNotificationService {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly settings: DeliveryNotificationSettingsService,
    private readonly claims: ShipmentNotificationStore,
    private readonly templateSend: TemplateSendService,
    private readonly conversations: ConversationService,
    private readonly customers: CustomerService,
    private readonly notifications: NotificationService,
    private readonly logger: AppLoggerService,
  ) {}

  async notify(
    tenantId: string,
    shipmentId: string,
    status: ShipmentStatus,
  ): Promise<DeliveryNotificationOutcome> {
    const shipment = await this.shipments.findById(tenantId, shipmentId);
    if (!shipment) return { outcome: 'not_found' };

    // Gate 1. The job may be running long after the sweep that queued it, by
    // which time the shipment may have moved on. Notifying about a status the
    // parcel has already left is worse than not notifying at all.
    // `isForwardTransition(status, current)` true means the parcel has moved
    // PAST the status this job is about — telling a customer it is out for
    // delivery when it was already delivered an hour ago is worse than
    // silence.
    if (
      shipment.currentStatus !== status &&
      isForwardTransition(status, shipment.currentStatus)
    ) {
      return {
        outcome: 'stale',
        detail: `shipment is already ${shipment.currentStatus}, not ${status}`,
      };
    }

    // Gates 2 and 3 are cheap and tenant-wide: check them before claiming, so
    // a tenant who has not opted in never accumulates claim rows.
    const settings = await this.settings.get(tenantId);
    if (!settings.enabled) {
      return await this.settle(
        tenantId,
        shipmentId,
        status,
        'skipped_disabled',
        'proactive delivery notifications are off for this workspace',
      );
    }

    const templateId = settings.statusTemplates[status];
    if (!templateId) {
      return await this.settle(
        tenantId,
        shipmentId,
        status,
        'skipped_no_template',
        `no template is mapped to "${status}"`,
      );
    }

    const customer = await this.customers.getCustomer(
      tenantId,
      shipment.customerId,
    );
    if (!customer) {
      return await this.settle(
        tenantId,
        shipmentId,
        status,
        'skipped_no_template',
        'the shipment has no reachable customer',
      );
    }

    const conversation = await this.conversations.getOrCreateConversation(
      tenantId,
      customer.phone,
    );

    // Gates 4 and 5 live in the shared send service — the same code the human
    // path runs, so an approval or consent rule can never apply to one caller
    // and not the other. `requireCategory: 'utility'` is the one thing this
    // caller pins: Meta bills and enforces per category, so a marketing
    // template for a shipment update is a policy violation as well as a
    // mis-bill.
    const values = this.buildValues(shipment.trackingNumber, status);
    const prepared = await this.templateSend.prepare({
      tenantId,
      conversation,
      templateId,
      values,
      requireCategory: 'utility',
    });

    if (!prepared.ok) {
      const outcome: ShipmentNotificationOutcome =
        prepared.reason === 'opted_out'
          ? 'skipped_opt_out'
          : 'skipped_no_template';
      if (outcome === 'skipped_no_template') {
        await this.warnMerchant(tenantId, status, prepared.message);
      }
      return await this.settle(
        tenantId,
        shipmentId,
        status,
        outcome,
        prepared.message,
      );
    }

    // A template whose placeholder count does not match the values we supply
    // would send with blanks, which reads as a broken message to the
    // customer. Refused rather than sent (D5 gate 4).
    const expected = templatePositions(prepared.plan.template.body).length;
    if (expected !== values.length) {
      const detail = `template expects ${expected} placeholder(s); a shipment notification supplies ${values.length}`;
      await this.warnMerchant(tenantId, status, detail);
      return await this.settle(
        tenantId,
        shipmentId,
        status,
        'skipped_no_template',
        detail,
      );
    }

    // Gate 6. The INSERT is the lock: no row back means a concurrent poll or
    // webhook already claimed this exact transition, and this caller stops
    // without reaching the BSP.
    const claimId = await this.claims.claim(tenantId, shipmentId, status);
    if (!claimId) return { outcome: 'already_claimed' };

    // `clientMessageId` is deterministic, so the existing
    // `findByClientMessageId` idempotency is a second barrier behind the
    // claim row.
    const messageId = await this.conversations.recordSystemTemplateMessage({
      tenantId,
      conversationId: conversation.id,
      content: prepared.plan.text,
      clientMessageId: `shipment:${shipmentId}:${status}`,
    });

    const dispatch = await this.templateSend.dispatch({
      plan: prepared.plan,
      to: conversation.customerPhone,
      values,
      context: `shipment ${shipmentId} -> ${status}`,
    });

    if (dispatch.delivered && dispatch.bspMessageId) {
      await this.conversations.attachOutboundDelivery(
        tenantId,
        messageId,
        dispatch.bspMessageId,
      );
      await this.claims.settle(tenantId, claimId, 'sent', {
        templateId,
        messageId,
      });
      // Console read convenience only — `shipment_notifications` remains the
      // dedup authority (D5).
      await this.shipments.markNotified(tenantId, shipmentId, status);
      return { outcome: 'sent' };
    }

    const detail = dispatch.deliveryError ?? 'send failed';
    await this.conversations.markOutboundFailed(tenantId, messageId, detail);
    await this.claims.settle(tenantId, claimId, 'failed', {
      templateId,
      messageId,
      detail,
    });
    return { outcome: 'failed', detail };
  }

  /**
   * The values a shipment notification supplies, in a fixed order the
   * merchant maps their template against: the tracking number, then the
   * human-readable status.
   *
   * Deliberately NOT courier prose: the values are our own normalized status
   * vocabulary and a number we issued, so a template can never render a
   * courier's free text to a customer.
   */
  private buildValues(
    trackingNumber: string,
    status: ShipmentStatus,
  ): string[] {
    return [trackingNumber, status.replace(/_/g, ' ')];
  }

  /**
   * D8: a missing or unusable template is a merchant problem, told to them
   * once per tenant per day rather than on every parcel — the dedup key is
   * what makes that true, not a timer.
   */
  private async warnMerchant(
    tenantId: string,
    status: ShipmentStatus,
    detail: string,
  ): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.notifications.record({
      tenantId,
      ...notificationContent.shipmentTemplateUnusable({ status, detail }),
      severity: 'warning',
      dedupKey: `shipment-template:${status}:${day}`,
    });
  }

  /** Claims, then immediately settles, a transition we are not going to send. */
  private async settle(
    tenantId: string,
    shipmentId: string,
    status: ShipmentStatus,
    outcome: ShipmentNotificationOutcome,
    detail: string,
  ): Promise<DeliveryNotificationOutcome> {
    const claimId = await this.claims.claim(tenantId, shipmentId, status);
    if (!claimId) return { outcome: 'already_claimed' };
    await this.claims.settle(tenantId, claimId, outcome, { detail });
    this.logger.debug(
      `shipment ${shipmentId} -> ${status}: ${outcome} (${detail})`,
      'DeliveryNotificationService',
    );
    return { outcome, detail };
  }
}
