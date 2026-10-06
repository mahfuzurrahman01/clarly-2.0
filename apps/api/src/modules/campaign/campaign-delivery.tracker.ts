// F19 (D5): per-campaign delivery, read and reply numbers.
//
// There is NO second webhook route, NO second signature check and NO second
// dedup table. `WebhookIngestService.applyStatusUpdates()` already receives
// every status callback and already writes `messages.delivery_status`; this
// adds exactly one call inside that existing loop.
//
// What that deliberately inherits: status callbacks are not rate-limited and
// not deduped, because the same `wamid` legitimately reports `sent`, then
// `delivered`, then `read`. Replay safety therefore has to come from the
// UPDATE itself — hence the monotonic rank guard below. A replayed `sent`
// after a `read` matches zero rows and changes nothing.
import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, sql, type SQL } from 'drizzle-orm';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { AppConfigService, Clock } from '../core';
import {
  campaignRecipients,
  customers,
  type CampaignDeliveryStatus,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/**
 * Monotonic ordering of delivery states. A callback only lands if it ranks
 * strictly higher than what is stored, so out-of-order and replayed webhooks
 * (both of which Meta sends) cannot walk a recipient backwards.
 *
 * `failed` is the highest rank because it is terminal: a late `delivered`
 * must not erase the record that the message failed.
 */
export const DELIVERY_STATUS_RANK: Readonly<
  Record<CampaignDeliveryStatus, number>
> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

export function deliveryStatusRank(
  status: CampaignDeliveryStatus | null,
): number {
  return status ? DELIVERY_STATUS_RANK[status] : 0;
}

/**
 * The guard, built FROM the rank table rather than restating it, so adding a
 * state cannot leave the SQL and the TypeScript disagreeing. Every literal
 * is a bound parameter.
 */
export function monotonicAdvanceGuard(next: CampaignDeliveryStatus): SQL {
  const arms = (
    Object.keys(DELIVERY_STATUS_RANK) as CampaignDeliveryStatus[]
  ).map((status) => sql`WHEN ${status} THEN ${DELIVERY_STATUS_RANK[status]}`);
  return sql`${DELIVERY_STATUS_RANK[next]} > CASE coalesce(${
    campaignRecipients.deliveryStatus
  }, '') ${sql.join(arms, sql` `)} ELSE 0 END`;
}

@Injectable()
export class CampaignDeliveryTracker {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {}

  /**
   * One conditional UPDATE on the partial unique index
   * `campaign_recipients_bsp_message_id_idx`.
   *
   * @returns whether a campaign recipient row was actually advanced. `false`
   * for an id that belongs to no campaign (expected traffic — most outbound
   * messages are not campaign messages) and for a stale replay.
   */
  async apply(
    tenantId: string,
    bspMessageId: string,
    status: CampaignDeliveryStatus,
    error: string | null,
  ): Promise<boolean> {
    const now = this.clock.now();

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(campaignRecipients)
          .set({
            deliveryStatus: status,
            deliveryError: error,
            deliveredAt:
              status === 'delivered'
                ? now
                : sql`${campaignRecipients.deliveredAt}`,
            readAt: status === 'read' ? now : sql`${campaignRecipients.readAt}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(campaignRecipients.tenantId, tenantId),
              eq(campaignRecipients.bspMessageId, bspMessageId),
              // The monotonic guard, evaluated in the database so two
              // concurrent callbacks cannot both read "nothing stored yet".
              monotonicAdvanceGuard(status),
            ),
          )
          .returning({ id: campaignRecipients.id }),
      tenantId,
    );

    return rows.length > 0;
  }

  /**
   * D5's reply attribution. A reply is not a status callback — it is an
   * inbound message — so this is called from the inbound branch of
   * `WebhookIngestService`, after the customer is resolved.
   *
   * LAST-TOUCH, and documented as such so nobody reads the number as
   * multi-touch: the most recent campaign message sent to this customer
   * inside the attribution window gets the credit, and only if it has not
   * already been credited.
   *
   * Never blocks or delays the respond path: the caller treats a failure as
   * a no-op.
   */
  async attributeReply(tenantId: string, customerId: string): Promise<boolean> {
    return this.credit(tenantId, eq(campaignRecipients.customerId, customerId));
  }

  /**
   * The same attribution, from the identity the webhook layer actually holds
   * at inbound time: a phone number on a channel.
   *
   * Resolving the customer first would mean a `getOrCreateByPhone` write on
   * the hot inbound path for the sake of a metric. The composite
   * `customers_tenant_id_phone_unique (tenant_id, channel, phone)` index
   * answers it as a join instead, inside the one transaction this already
   * opens.
   */
  async attributeReplyFromPhone(
    tenantId: string,
    phone: string,
    channel: ChannelKind,
  ): Promise<boolean> {
    return this.credit(
      tenantId,
      and(eq(customers.phone, phone), eq(customers.channel, channel))!,
      true,
    );
  }

  /**
   * Credits the most recent uncredited campaign message to this customer
   * inside the attribution window.
   *
   * One indexed read on `campaign_recipients_tenant_customer_sent_idx`, then
   * one keyed UPDATE — rather than `UPDATE ... ORDER BY ... LIMIT`, which
   * Postgres does not support directly.
   */
  private async credit(
    tenantId: string,
    subject: SQL,
    joinCustomers = false,
  ): Promise<boolean> {
    const now = this.clock.now();
    const windowStart = new Date(
      now.getTime() -
        this.config.campaignReplyAttributionDays * 24 * 60 * 60 * 1000,
    );

    const rows = await this.tenantContext.withTenantTx(async (tx) => {
      const base = tx
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients);
      const scoped = joinCustomers
        ? base.innerJoin(
            customers,
            and(
              eq(customers.id, campaignRecipients.customerId),
              eq(customers.tenantId, campaignRecipients.tenantId),
            ),
          )
        : base;

      const candidate = await scoped
        .where(
          and(
            eq(campaignRecipients.tenantId, tenantId),
            subject,
            eq(campaignRecipients.status, 'sent'),
            isNull(campaignRecipients.repliedAt),
            gte(campaignRecipients.sentAt, windowStart),
          ),
        )
        .orderBy(sql`${campaignRecipients.sentAt} DESC`)
        .limit(1);

      const target = candidate[0];
      if (!target) return [];

      return tx
        .update(campaignRecipients)
        .set({ repliedAt: now, updatedAt: now })
        .where(
          and(
            eq(campaignRecipients.id, target.id),
            eq(campaignRecipients.tenantId, tenantId),
            // Re-checked so two inbound messages racing cannot both credit
            // the same row.
            isNull(campaignRecipients.repliedAt),
          ),
        )
        .returning({ id: campaignRecipients.id });
    }, tenantId);

    return rows.length > 0;
  }
}
