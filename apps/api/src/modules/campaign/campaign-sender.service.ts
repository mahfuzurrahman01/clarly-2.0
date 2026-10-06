// F19 (D3): one recipient, end to end — claim, send, account.
//
// The order below is the whole safety argument, and it is deliberate:
//
//   1. rate limits            — cheapest, and a refusal must leave the row
//                               untouched and PENDING (nothing claimed, so
//                               nothing to unwind)
//   2. consent re-check       — a customer can send STOP between snapshot and
//                               send; that is a visible `skipped / opted_out`
//                               outcome, never a silent drop
//   3. spend cap              — checked BEFORE the claim, so a campaign that
//                               must pause leaves every remaining recipient
//                               pending
//   4. CLAIM (UPDATE ... WHERE status = 'pending' RETURNING)
//   5. the Graph call
//   6. mark sent + increment `spent_usd` IN ONE TRANSACTION
//
// Step 4 before step 5 is the `comment_actions` rule applied to money: a
// retried job must not bill the tenant — or message the customer — twice.
// Step 6 in one transaction is why the spend guard can trust what it reads:
// `spent_usd` is not a counter updated afterwards, it is the thing the guard
// reads.
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AppLoggerService, Clock } from '../core';
import { ConversationService } from '../conversation/conversation.service';
import {
  campaignRecipients,
  campaigns,
  customers,
  type CampaignTemplateValue,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import { renderTemplateBody } from '../templates/templates.module';
import { CampaignRateLimiter } from './campaign-rate-limiter.service';
import { CampaignDeferredError, CampaignPausedError } from './campaign.errors';
import { estimateMessageCostUsd, round4 } from './campaign-pricing';

const CONTEXT = 'CampaignSenderService';

/** Everything about the campaign that does not change between recipients. Read once per batch, not once per recipient. */
export interface CampaignSendContext {
  tenantId: string;
  campaignId: string;
  phoneNumberId: string;
  templateName: string;
  templateLanguage: string;
  templateBody: string;
  templateValues: CampaignTemplateValue[];
  /** `campaigns.created_by` — the person who launched it. Nullable for rows that predate user tracking. */
  launchedBy: string | null;
  messagingLimitTier: string | null;
  qualityRating: string | null;
}

export type SendOutcome =
  | 'sent'
  | 'failed'
  | 'skipped_opted_out'
  | 'skipped_invalid_phone'
  /** Another worker holds this recipient. Not an error and not a drop — the holder finishes it. */
  | 'already_claimed';

@Injectable()
export class CampaignSenderService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly limiter: CampaignRateLimiter,
    private readonly conversations: ConversationService,
    private readonly bspAdapter: BspAdapter,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * @throws CampaignDeferredError when a Meta limit says "not now" — the
   * recipient stays `pending` and the processor delays the job.
   * @throws CampaignPausedError when the next message would cross the spend
   * cap — the recipient stays `pending` and the campaign stops.
   */
  async sendOne(
    ctx: CampaignSendContext,
    recipientId: string,
  ): Promise<SendOutcome> {
    const now = this.clock.now();

    // 1. Rate limits, before anything is claimed. Over a limit is a
    //    DEFERRAL: the job is re-queued with `retryAfterMs` and the row is
    //    still pending, untouched. (A unit of allowance is consumed even if
    //    the recipient then turns out to be opted out — deliberately
    //    conservative: it under-sends against Meta's limit, never over.)
    await this.assertWithinLimits(ctx, now);

    const prepared = await this.prepare(ctx, recipientId, now);
    if (prepared.outcome) return prepared.outcome;

    const { phone, customerName, costUsd } = prepared;

    // 5. The Graph call. The transcript row is written first, exactly as
    //    TemplateReplyService does, so a send that fails still appears in the
    //    conversation as a message that did not arrive.
    const bodyParameters = renderParameters(ctx.templateValues, {
      name: customerName,
      phone,
    });
    const text = renderTemplateBody(ctx.templateBody, bodyParameters);

    const conversation = await this.conversations.getOrCreateConversation(
      ctx.tenantId,
      phone,
      ctx.phoneNumberId,
      'whatsapp',
    );
    const messageId = await this.conversations.recordHumanAgentMessage({
      tenantId: ctx.tenantId,
      conversationId: conversation.id,
      content: text,
      // D6: recorded as `human_agent` — a business-initiated message a person
      // authored. It deliberately does NOT start a handover: unlike a console
      // template reply, nobody is sitting on 40 000 conversations.
      authorUserId: ctx.launchedBy,
      clientMessageId: campaignClientMessageId(ctx.campaignId, recipientId),
    });

    try {
      const { bspMessageId } = await this.bspAdapter.sendTemplateMessage({
        phoneNumberId: ctx.phoneNumberId,
        to: phone,
        templateName: ctx.templateName,
        language: ctx.templateLanguage,
        bodyParameters,
      });
      await this.conversations.attachOutboundDelivery(
        ctx.tenantId,
        messageId,
        bspMessageId,
      );
      await this.recordSent(ctx, recipientId, {
        messageId,
        conversationId: conversation.id,
        bspMessageId,
        costUsd,
        now: this.clock.now(),
      });
      return 'sent';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `campaign ${ctx.campaignId} recipient ${recipientId} failed to send: ${detail}`,
        CONTEXT,
      );
      await this.conversations.markOutboundFailed(
        ctx.tenantId,
        messageId,
        detail,
      );
      // A failed send costs nothing — Meta does not bill an undelivered
      // conversation — so `spent_usd` is deliberately NOT incremented here.
      await this.recordFailed(
        ctx,
        recipientId,
        messageId,
        conversation.id,
        detail,
      );
      return 'failed';
    }
  }

  private async assertWithinLimits(
    ctx: CampaignSendContext,
    now: Date,
  ): Promise<void> {
    const throughput = await this.limiter.throughput(ctx.phoneNumberId, now);
    if (!throughput.allowed) {
      throw new CampaignDeferredError(
        throughput.retryAfterMs,
        throughput.reason,
      );
    }
    const daily = await this.limiter.dailyConversation(
      ctx.phoneNumberId,
      ctx.messagingLimitTier,
      ctx.qualityRating,
      now,
    );
    if (!daily.allowed) {
      throw new CampaignDeferredError(daily.retryAfterMs, daily.reason);
    }
  }

  /**
   * Steps 2-4 in one transaction: read the recipient with its customer's
   * live consent, terminate it if consent is gone, refuse if the next
   * message would cross the cap, then claim it.
   */
  private async prepare(
    ctx: CampaignSendContext,
    recipientId: string,
    now: Date,
  ): Promise<
    | {
        outcome: SendOutcome;
        phone?: undefined;
        customerName?: undefined;
        costUsd?: undefined;
      }
    | {
        outcome: null;
        phone: string;
        customerName: string | null;
        costUsd: number;
      }
  > {
    const result = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .select({
          status: campaignRecipients.status,
          phone: campaignRecipients.phone,
          customerName: customers.name,
          optedOutAt: customers.optedOutAt,
          marketingOptedOutAt: customers.marketingOptedOutAt,
          spentUsd: campaigns.spentUsd,
          spendCapUsd: campaigns.spendCapUsd,
        })
        .from(campaignRecipients)
        .innerJoin(
          customers,
          and(
            eq(customers.id, campaignRecipients.customerId),
            eq(customers.tenantId, campaignRecipients.tenantId),
          ),
        )
        .innerJoin(
          campaigns,
          and(
            eq(campaigns.id, campaignRecipients.campaignId),
            eq(campaigns.tenantId, campaignRecipients.tenantId),
          ),
        )
        .where(
          and(
            eq(campaignRecipients.id, recipientId),
            eq(campaignRecipients.tenantId, ctx.tenantId),
            eq(campaignRecipients.campaignId, ctx.campaignId),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row || row.status !== 'pending') {
        return { kind: 'already_claimed' as const };
      }

      // 2. Consent, re-checked per recipient: a customer can send STOP
      //    between the snapshot and the send. A visible outcome, not a drop.
      if (row.optedOutAt != null || row.marketingOptedOutAt != null) {
        await tx
          .update(campaignRecipients)
          .set({
            status: 'skipped',
            skipReason: 'opted_out',
            updatedAt: now,
          })
          .where(
            and(
              eq(campaignRecipients.id, recipientId),
              eq(campaignRecipients.tenantId, ctx.tenantId),
              eq(campaignRecipients.status, 'pending'),
            ),
          );
        return { kind: 'opted_out' as const };
      }

      if (!isSendablePhone(row.phone)) {
        await tx
          .update(campaignRecipients)
          .set({
            status: 'skipped',
            skipReason: 'invalid_phone',
            updatedAt: now,
          })
          .where(
            and(
              eq(campaignRecipients.id, recipientId),
              eq(campaignRecipients.tenantId, ctx.tenantId),
              eq(campaignRecipients.status, 'pending'),
            ),
          );
        return { kind: 'invalid_phone' as const };
      }

      // 3. Spend cap, BEFORE the claim, so pausing leaves the row pending.
      const costUsd = estimateMessageCostUsd(row.phone);
      if (round4(row.spentUsd + costUsd) > row.spendCapUsd) {
        return {
          kind: 'spend_cap' as const,
          spentUsd: row.spentUsd,
          spendCapUsd: row.spendCapUsd,
          costUsd,
        };
      }

      // 4. THE CLAIM. No row returned -> someone else has it -> skip.
      const claimed = await tx
        .update(campaignRecipients)
        .set({
          status: 'sending',
          attemptCount: sql`${campaignRecipients.attemptCount} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(campaignRecipients.id, recipientId),
            eq(campaignRecipients.campaignId, ctx.campaignId),
            eq(campaignRecipients.tenantId, ctx.tenantId),
            eq(campaignRecipients.status, 'pending'),
          ),
        )
        .returning({ id: campaignRecipients.id });

      if (claimed.length === 0) return { kind: 'already_claimed' as const };

      return {
        kind: 'claimed' as const,
        phone: row.phone,
        customerName: row.customerName,
        costUsd,
      };
    }, ctx.tenantId);

    switch (result.kind) {
      case 'already_claimed':
        return { outcome: 'already_claimed' };
      case 'opted_out':
        return { outcome: 'skipped_opted_out' };
      case 'invalid_phone':
        return { outcome: 'skipped_invalid_phone' };
      case 'spend_cap':
        throw new CampaignPausedError(
          'spend_cap',
          `spent $${result.spentUsd.toFixed(4)} of a $${result.spendCapUsd.toFixed(2)} cap; the next message costs about $${result.costUsd.toFixed(4)}`,
        );
      default:
        return {
          outcome: null,
          phone: result.phone,
          customerName: result.customerName,
          costUsd: result.costUsd,
        };
    }
  }

  /** Step 6: the recipient flips to `sent` and `spent_usd` moves IN THE SAME TRANSACTION. */
  private async recordSent(
    ctx: CampaignSendContext,
    recipientId: string,
    input: {
      messageId: string;
      conversationId: string;
      bspMessageId: string;
      costUsd: number;
      now: Date;
    },
  ): Promise<void> {
    await this.tenantContext.withTenantTx(async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({
          status: 'sent',
          messageId: input.messageId,
          conversationId: input.conversationId,
          bspMessageId: input.bspMessageId,
          deliveryStatus: 'sent',
          costUsd: input.costUsd,
          sentAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(campaignRecipients.id, recipientId),
            eq(campaignRecipients.tenantId, ctx.tenantId),
          ),
        );

      await tx
        .update(campaigns)
        .set({
          spentUsd: sql`round(${campaigns.spentUsd} + ${input.costUsd}, 4)`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(campaigns.id, ctx.campaignId),
            eq(campaigns.tenantId, ctx.tenantId),
          ),
        );
    }, ctx.tenantId);
  }

  private async recordFailed(
    ctx: CampaignSendContext,
    recipientId: string,
    messageId: string,
    conversationId: string,
    detail: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(campaignRecipients)
          .set({
            status: 'failed',
            messageId,
            conversationId,
            deliveryStatus: 'failed',
            deliveryError: detail,
            updatedAt: now,
          })
          .where(
            and(
              eq(campaignRecipients.id, recipientId),
              eq(campaignRecipients.tenantId, ctx.tenantId),
            ),
          ),
      ctx.tenantId,
    );
  }
}

/**
 * The idempotency key on the transcript row. Deterministic per recipient, so
 * a retried job that somehow reached this point twice hits
 * `messages_client_message_id` rather than writing a second transcript line.
 */
export function campaignClientMessageId(
  campaignId: string,
  recipientId: string,
): string {
  return `campaign:${campaignId}:${recipientId}`;
}

/**
 * D2's closed `template_values` grammar, resolved per customer. No
 * expressions, no arbitrary column access — a `literal` or one of two
 * whitelisted customer fields, each with a mandatory fallback because Meta
 * rejects an empty parameter and "Hi , your order..." is worse than
 * "Hi there".
 */
export function renderParameters(
  values: readonly CampaignTemplateValue[],
  customer: { name: string | null; phone: string },
): string[] {
  return values.map((value) => {
    if (value.type === 'literal') return value.value;
    const field = value.field === 'name' ? customer.name : customer.phone;
    const resolved = (field ?? '').trim();
    return resolved.length > 0 ? resolved : value.fallback;
  });
}

/** A snapshotted phone must still look like something Meta can route. Cheap, and the alternative is a guaranteed Graph error per row. */
export function isSendablePhone(phone: string | null | undefined): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}
