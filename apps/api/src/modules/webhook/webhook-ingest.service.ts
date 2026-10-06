// Channel (WebhookModule): the orchestrator a future WebhookController
// (gated on T0 sign-off, see whatsapp/ports/bsp-adapter.port.ts) will call.
// Everything here is BSP-agnostic — it depends on the BspAdapter PORT, not
// any concrete vendor, so it's fully buildable/testable now even though T0
// itself is still pending. Order matters and is deliberate:
//
//   1. verify signature            — reject forgeries before parsing untrusted bytes
//   2. parse -> normalized messages
//   per message:
//   3. resolve tenant (T6)         — before ANY tenant-scoped work
//   4. rate limit (T17)            — before dedup/DB writes, cheapest check first
//   5. dedup (T6)                  — short-circuit replays before escalation/enqueue
//   6. non-text -> record the message + queue its bytes (F13), escalate
//      (T3); else enqueue respond-path (T11)
//
// Signature verification failing throws — a WebhookController wraps that
// as a 401/403. Everything else is per-message and collected into a
// summary rather than throwing, since one malformed/duplicate message in a
// batch must not fail the whole webhook delivery (T11's <1s ACK budget
// depends on this handler never blocking on, or being brought down by, one
// bad message).
import { Injectable } from '@nestjs/common';
import { classifyDeclaredMedia } from '../agent/media/media-whitelist';
import type {
  ChannelAdapter,
  NormalizedInboundMessage,
  NormalizedOutboundEcho,
} from '../channel/ports/channel-adapter.port';
import { CampaignDeliveryTracker } from '../campaign/campaign-delivery.tracker';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { CommentThreadService } from '../comments/comment-thread.service';
import { ConversationService } from '../conversation/conversation.service';
import { parseConsentKeyword } from '../customer/consent-keyword';
import { isMarketingOptOutKeyword } from '../customer/marketing-consent-keyword';
import { CustomerConsentService } from '../customer/customer-consent.service';
import { CustomerService } from '../customer/customer.service';
import { TenantStatusService } from '../tenant-context/tenant-status.service';
import { TicketEscalationService } from '../ticket/ticket-escalation.service';
import { MediaIntakeService } from './media-intake.service';
import { RespondPathProducerService } from './respond-path-producer.service';
import { WebhookDedupService } from './webhook-dedup.service';
import { WebhookRateLimiterService } from './webhook-rate-limiter.service';
import { ChannelTenantResolver } from './channel-tenant-resolver.service';

export type MessageOutcome =
  | 'enqueued'
  /** F17: an image or voice message accepted for understanding. The respond path is enqueued by MediaDownloadProcessor once the bytes are actually in storage — not here, because at this point we have a media id and nothing else. */
  | 'media_queued_for_understanding'
  | 'escalated_unsupported_media'
  | 'escalated_opted_out'
  | 'opted_out'
  | 'opted_in'
  | 'marketing_opted_out'
  | 'duplicate'
  | 'workspace_closed'
  | 'rate_limited'
  | 'delivery_status_applied'
  | 'delivery_status_unmatched'
  /** Gulf T3 (D13): a WhatsApp Business app echo, stored as human-sent. Never enqueued for the agent. */
  | 'business_app_echo_recorded';

export interface WebhookIngestResult {
  providerMessageId: string;
  outcome: MessageOutcome;
}

@Injectable()
export class WebhookIngestService {
  constructor(
    private readonly tenantResolution: ChannelTenantResolver,
    private readonly tenantStatus: TenantStatusService,
    private readonly rateLimiter: WebhookRateLimiterService,
    private readonly dedup: WebhookDedupService,
    private readonly respondPathProducer: RespondPathProducerService,
    private readonly ticketEscalation: TicketEscalationService,
    private readonly customerService: CustomerService,
    private readonly consent: CustomerConsentService,
    private readonly conversationService: ConversationService,
    private readonly mediaIntake: MediaIntakeService,
    private readonly commentThreads: CommentThreadService,
    /** F19 (D5): per-campaign delivery/read/reply numbers, off the rows this service already writes. */
    private readonly campaignDelivery: CampaignDeliveryTracker,
  ) {}

  async ingest(
    adapter: ChannelAdapter,
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): Promise<WebhookIngestResult[]> {
    if (!adapter.verifyWebhookSignature(rawBody, headers)) {
      throw new WebhookSignatureVerificationError();
    }

    const messages = adapter.parseInboundWebhook(rawBody);
    const results: WebhookIngestResult[] = [];

    // Status callbacks share this endpoint and parse to zero inbound
    // messages, so until now a delivery/read/failure receipt was a silent
    // no-op ACK. They are applied first and unconditionally: a status is
    // never rate-limited (it is our own message's fate, not tenant traffic)
    // and never deduped (the same id legitimately reports sent, then
    // delivered, then read).
    results.push(...(await this.applyStatusUpdates(adapter, rawBody)));
    results.push(...(await this.recordOutboundEchoes(adapter, rawBody)));

    results.push(...(await this.ingestMessages(messages)));
    return results;
  }

  /**
   * Clarly 2.0 S3: the per-message half of `ingest()`, for channels whose
   * inbound messages do not arrive as a provider webhook — the website widget,
   * whose own controller authenticates the visitor (widget key, origin,
   * signed visitor token) and builds the normalized message itself. Everything
   * from tenant resolution onwards (closure, rate limit, dedup, consent,
   * media, respond path, attribution) is the same code path every channel
   * takes, so the widget gets no rule a WhatsApp message does not.
   */
  async ingestMessages(
    messages: readonly NormalizedInboundMessage[],
  ): Promise<WebhookIngestResult[]> {
    const results: WebhookIngestResult[] = [];
    for (const message of messages) {
      // T6: resolves the tenant BEFORE any tenant-scoped work; an
      // unrecognized phone_number_id throws UnknownWhatsappNumberError,
      // which is deliberately allowed to propagate (not swallowed per
      // message) — a webhook for a number we don't recognize at all is a
      // routing problem worth failing loudly on, not a per-message outcome
      // to silently skip.
      const tenantId = await this.tenantResolution.resolveTenantId(
        message.channel,
        message.channelAccountId,
      );

      // A closed workspace stops serving customers here, not just in the
      // console. TenantAuthMiddleware gates every authenticated route on
      // closure, but the BSP webhook is unauthenticated and never passes
      // through it — so without this check a closed account keeps ingesting
      // messages, keeps spending on LLM turns, keeps writing personal data
      // into a workspace already scheduled for erasure, and keeps answering
      // customers as though it were open. Placed ahead of the rate limiter
      // and dedup so a closed tenant records nothing at all. The webhook
      // still ACKs 200: the message is genuinely handled — by being
      // dropped — and telling the BSP otherwise only earns a redelivery.
      if (await this.tenantStatus.isClosed(tenantId)) {
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: 'workspace_closed',
        });
        continue;
      }

      const allowed = await this.rateLimiter.allow(tenantId);
      if (!allowed) {
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: 'rate_limited',
        });
        continue;
      }

      // T6 unchanged and deliberately NOT rebuilt per channel: the dedup key
      // is (tenantId, provider message id), and Meta's `mid.*` is as unique
      // and as verbatim-redelivered as WhatsApp's `wamid.*`. A replayed
      // Messenger webhook short-circuits here on exactly the same unique
      // constraint a replayed WhatsApp one does.
      const { isDuplicate } = await this.dedup.checkAndRecord(
        tenantId,
        message.providerMessageId,
      );
      if (isDuplicate) {
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: 'duplicate',
        });
        continue;
      }

      // Gulf T8 (D15b): if this sender is answering a comment private reply,
      // the conversation starts HERE — with our private reply as its first
      // agent message — and the DM then carries on down the normal path
      // below (consent, media, respond path) exactly like any other DM.
      // After dedup, so a replayed DM can never adopt anything twice.
      await this.commentThreads.adoptOnCustomerMessage({
        tenantId,
        channel: message.channel,
        channelAccountId: message.channelAccountId,
        from: message.from,
      });

      if (message.type !== 'text') {
        // T13: resolve/create the customer + conversation so this ticket
        // carries the same customerId/conversationId every other
        // escalation path does — a non-text message is still part of the
        // same customer thread, not a second-class record.
        const customer = await this.customerService.getOrCreateByPhone(
          tenantId,
          message.from,
          message.channel,
        );
        const conversation =
          await this.conversationService.getOrCreateConversation(
            tenantId,
            message.from,
            message.channelAccountId,
            message.channel,
          );
        // F13: the message is recorded and its bytes queued BEFORE any
        // ticket, so a human opening that ticket finds the attachment already
        // on the thread rather than a conversation that appears to contain
        // nothing. Previously no `messages` row was written at all and the
        // transcript simply omitted what the customer sent.
        //
        // F17, T3's amended escalation matrix. An image or a voice note in
        // the understanding whitelist is no longer an automatic handoff: it
        // gets a real answer attempt and escalates on low confidence exactly
        // as a typed question does. Only media we genuinely cannot read —
        // documents, video, stickers, anything outside the whitelist — still
        // hard-escalates here.
        //
        // An opted-out customer is the one exception that keeps escalating
        // whatever they sent: they re-opened the window themselves, which is
        // not consent to be auto-replied to (same rule as the text branch
        // below, applied before the modality decision rather than after).
        // Nothing to fetch means nothing to understand: with no media handle
        // the message escalates, whatever its declared type (Gulf T6 made an
        // undeclared mime type classify by type alone, so this is explicit).
        const understandable = message.media
          ? classifyDeclaredMedia(message.type, message.media.mimeType)
          : null;
        const optedOut =
          understandable !== null &&
          (await this.consent.isOptedOut(
            tenantId,
            message.from,
            message.channel,
          ));
        const recorded = await this.mediaIntake.record(
          tenantId,
          conversation.id,
          message,
          optedOut ? null : understandable,
        );

        if (understandable) {
          if (optedOut) {
            // The reason is decided HERE, at the check that decides it: this
            // is an opt-out handoff, not an unreadable attachment. Labelling
            // it UNSUPPORTED_MEDIA would put a consent decision in the
            // media bucket of A9's escalation mix.
            await this.ticketEscalation.createTicket({
              tenantId,
              customerId: customer.id,
              conversationId: conversation.id,
              escalationReason: 'OPTED_OUT_CUSTOMER',
              note: `${message.from} has opted out of automated messaging but sent a ${message.type} message — a human must answer this one.`,
            });
            results.push({
              providerMessageId: message.providerMessageId,
              outcome: 'escalated_opted_out',
            });
            continue;
          }
          // No ticket, and no respond-path enqueue yet: the bytes are still
          // being fetched by the media-download worker (T11's <1s ACK budget
          // forbids fetching them here), and answering a photo we do not have
          // is not possible. MediaDownloadProcessor enqueues the turn once
          // the attachment is actually stored, and escalates if it never is.
          //
          // ...unless the download job never made it onto the queue at all.
          // Nothing downstream would ever run for that message, and it now has
          // no ticket behind it either, so this is the one place that can stop
          // it becoming a silent drop.
          if (recorded?.queued) {
            results.push({
              providerMessageId: message.providerMessageId,
              outcome: 'media_queued_for_understanding',
            });
            continue;
          }
        }

        await this.ticketEscalation.createTicket({
          tenantId,
          customerId: customer.id,
          conversationId: conversation.id,
          escalationReason: 'UNSUPPORTED_MEDIA',
          note: `Unsupported message type "${message.type}" from ${message.from} on ${message.channel} (providerMessageId=${message.providerMessageId})`,
        });
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: 'escalated_unsupported_media',
        });
        continue;
      }

      // F19 (Open Question 2): "STOP MARKETING"/"UNSUBSCRIBE" is checked
      // BEFORE the global STOP handler below, so it sets only
      // marketingOptedOutAt rather than falling through to the global
      // opt-out — a customer who only wants fewer broadcasts is not the same
      // as one who wants to stop hearing from us entirely, including a human
      // replying inside the service window.
      if (isMarketingOptOutKeyword(message.text)) {
        await this.consent.recordMarketingOptOut(
          tenantId,
          message.from,
          message.channel,
        );
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: 'marketing_opted_out',
        });
        continue;
      }

      // Consent is decided BEFORE the agent is queued, not after. A STOP that
      // is honoured only once the reply pipeline gets round to it is a STOP
      // the customer watched us ignore.
      const consentKeyword = parseConsentKeyword(message.text);
      if (consentKeyword) {
        if (consentKeyword === 'opt_out') {
          await this.consent.recordOptOut(
            tenantId,
            message.from,
            'customer_keyword',
            message.channel,
          );
        } else {
          await this.consent.recordOptIn(
            tenantId,
            message.from,
            message.channel,
          );
        }
        // No auto-reply either way. Confirming an opt-out with a message is
        // itself a message to someone who just asked for none, and WhatsApp
        // sends its own confirmation for STOP.
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: consentKeyword === 'opt_out' ? 'opted_out' : 'opted_in',
        });
        continue;
      }

      // An opted-out customer messaging again has re-opened the service window
      // themselves, but that is not consent to be auto-replied to. Their
      // message still reaches a human; the agent stays quiet.
      if (
        await this.consent.isOptedOut(tenantId, message.from, message.channel)
      ) {
        const customer = await this.customerService.getOrCreateByPhone(
          tenantId,
          message.from,
          message.channel,
        );
        const conversation =
          await this.conversationService.getOrCreateConversation(
            tenantId,
            message.from,
            message.channelAccountId,
            message.channel,
          );
        await this.ticketEscalation.createTicket({
          tenantId,
          customerId: customer.id,
          conversationId: conversation.id,
          escalationReason: 'OPTED_OUT_CUSTOMER',
          note: `${message.from} has opted out of automated messaging but sent a message — a human must answer this one.`,
        });
        results.push({
          providerMessageId: message.providerMessageId,
          outcome: 'escalated_opted_out',
        });
        continue;
      }

      await this.respondPathProducer.enqueue({
        tenantId,
        channel: message.channel,
        channelAccountId: message.channelAccountId,
        providerMessageId: message.providerMessageId,
        from: message.from,
        text: message.text ?? '',
      });
      // F19 (D5): last-touch campaign reply attribution, AFTER the respond
      // path is already moving and deliberately never able to block or fail
      // it — a metric must not be able to stop a customer getting an answer.
      await this.attributeCampaignReply(
        tenantId,
        message.from,
        message.channel,
      );
      results.push({
        providerMessageId: message.providerMessageId,
        outcome: 'enqueued',
      });
    }

    return results;
  }

  /**
   * F19 (D5). Last-touch, and documented as such so nobody reads the number
   * as multi-touch: the most recent campaign message sent to this customer
   * inside `CAMPAIGN_REPLY_ATTRIBUTION_DAYS` gets the credit, once.
   *
   * Swallowed on failure by design. This is the only call in the inbound
   * loop that exists purely for reporting, and a reporting write must never
   * be the reason an inbound message 500s back to Meta and gets redelivered.
   */
  private async attributeCampaignReply(
    tenantId: string,
    phone: string,
    channel: ChannelKind,
  ): Promise<void> {
    try {
      await this.campaignDelivery.attributeReplyFromPhone(
        tenantId,
        phone,
        channel,
      );
    } catch {
      // Intentionally silent: see above.
    }
  }

  private async applyStatusUpdates(
    adapter: ChannelAdapter,
    rawBody: string | Buffer,
  ): Promise<WebhookIngestResult[]> {
    const results: WebhookIngestResult[] = [];

    for (const update of adapter.parseStatusUpdates(rawBody)) {
      const tenantId = await this.tenantResolution.resolveTenantId(
        update.channel,
        update.channelAccountId,
      );
      // Same closure gate as inbound messages: a closed workspace takes no
      // further writes of any kind, delivery receipts included.
      if (await this.tenantStatus.isClosed(tenantId)) {
        results.push({
          providerMessageId: update.providerMessageId,
          outcome: 'workspace_closed',
        });
        continue;
      }

      const applied = await this.conversationService.applyDeliveryStatus(
        tenantId,
        update.providerMessageId,
        update.status,
        update.error,
      );
      // F19 (D5): per-campaign delivery numbers are the SAME rows this loop
      // already receives — no second webhook route, no second signature
      // check, no second dedup table. One monotonic UPDATE keyed on
      // `bsp_message_id`; an id that belongs to no campaign is a no-op,
      // exactly as applyDeliveryStatus already treats one.
      await this.campaignDelivery.apply(
        tenantId,
        update.providerMessageId,
        update.status,
        update.error,
      );
      results.push({
        providerMessageId: update.providerMessageId,
        // 'unmatched' is expected traffic, not an error: Meta reports on
        // messages older than our retention window and on messages sent
        // outside this system.
        outcome: applied
          ? 'delivery_status_applied'
          : 'delivery_status_unmatched',
      });
    }

    return results;
  }

  /**
   * Gulf T3 (D13): messages the business sent from the WhatsApp Business
   * app on a coexistence number. Recorded in the conversation as human-sent
   * and NEVER handed to the respond path: there is nothing to answer, and
   * the agent must not talk over a human. The conversation is put in human
   * hands exactly as a console reply does (HumanReplyService), so the agent
   * stays quiet until it is handed back or the handover goes stale.
   *
   * Not rate-limited (the tenant's own traffic, not inbound load) but
   * deduped, since Meta redelivers echoes like any other webhook.
   */
  private async recordOutboundEchoes(
    adapter: ChannelAdapter,
    rawBody: string | Buffer,
  ): Promise<WebhookIngestResult[]> {
    const results: WebhookIngestResult[] = [];

    for (const echo of adapter.parseOutboundEchoes(rawBody)) {
      const tenantId = await this.tenantResolution.resolveTenantId(
        echo.channel,
        echo.channelAccountId,
      );
      if (await this.tenantStatus.isClosed(tenantId)) {
        results.push({
          providerMessageId: echo.providerMessageId,
          outcome: 'workspace_closed',
        });
        continue;
      }
      const { isDuplicate } = await this.dedup.checkAndRecord(
        tenantId,
        echo.providerMessageId,
      );
      if (isDuplicate) {
        results.push({
          providerMessageId: echo.providerMessageId,
          outcome: 'duplicate',
        });
        continue;
      }

      await this.customerService.getOrCreateByPhone(
        tenantId,
        echo.to,
        echo.channel,
      );
      const conversation =
        await this.conversationService.getOrCreateConversation(
          tenantId,
          echo.to,
          echo.channelAccountId,
          echo.channel,
        );
      await this.conversationService.recordBusinessAppEcho({
        tenantId,
        conversationId: conversation.id,
        providerMessageId: echo.providerMessageId,
        content: describeEcho(echo),
        sentAt: echo.sentAt,
      });
      await this.conversationService.startHandover(
        tenantId,
        conversation.id,
        null,
        echo.sentAt,
      );
      results.push({
        providerMessageId: echo.providerMessageId,
        outcome: 'business_app_echo_recorded',
      });
    }

    return results;
  }
}

/** The echo's text, else its caption, else a plain marker — prompt assembly and the summary read this, so it says what happened in words. */
function describeEcho(echo: NormalizedOutboundEcho): string {
  if (echo.text) return echo.text;
  if (echo.media?.caption) return echo.media.caption;
  return `[${echo.type === 'unsupported' ? 'message' : echo.type} sent from the WhatsApp Business app]`;
}

export class WebhookSignatureVerificationError extends Error {
  constructor() {
    super('Webhook signature verification failed.');
    this.name = 'WebhookSignatureVerificationError';
  }
}
