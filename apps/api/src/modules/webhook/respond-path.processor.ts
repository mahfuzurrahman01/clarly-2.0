// Channel (WebhookModule, T11/T10/Feature 4/5): the worker half of the
// async job boundary — and, as of Feature 4, the actual respond path.
// AgentRuntime.respond() (Feature 3) is called for real here for the first
// time; every prior slice's placeholder is gone.
//
// Sequence: acquire the T10 advisory lock -> get-or-create the customer
// (T13) + conversation -> read PRIOR conversation state (tenant policy,
// recent window, summary — read BEFORE this turn's inbound messages are
// recorded, so they don't duplicate what's passed as `currentMessage`) ->
// call AgentRuntime -> record both the inbound batch and the assistant's
// reply -> if the turn escalated, create a ticket with the real D13
// escalation_reason, the resolved customerId (T13), and the run's
// confidence/citations (T8's batch-loader needs these as real columns,
// not derived at read time) -> trigger A7's summarization check (cheap;
// the actual LLM summarization call runs in its own worker, off this
// path).
//
// A missing tenant_policy row is treated as a genuine configuration error
// (thrown, not defaulted) — Feature 2.5 deliberately does not auto-create
// one, so a tenant reaching this path without ever being seeded is a real
// gap to surface via T11's existing retry/DLQ/ticket machinery, not paper
// over with guessed defaults.
//
// As of 2026-08-15 (T0) this processor also SENDS
// `result.answer` back to the customer via a bound `ChannelAdapter`
// (Feature 16 — it was a single `BspAdapter` before) resolved from the
// channel already on the job payload — the
// last open link in the loop. Delivery failure is deliberately escalated
// to a human rather than retried; see deliverAnswer()'s call site for why.
// Since 2026-08-17 that escalation carries its own reason,
// `DELIVERY_FAILURE`, not `TOOL_FAILURE`: an outbound send that fails is our
// (or the tenant's credentials') problem, while TOOL_FAILURE means the
// agent's own tool calls broke. They used to share a bucket, which made the
// escalation mix we quote to a tenant unreadable — one expired channel token
// looked identical to broken agent tooling.
//
// @OnWorkerEvent('failed') creates a JOB_FAILURE ticket for unexpected JOB
// failures (exceptions/exhausted retries) — distinct from the in-band
// escalation-ticket path above, which represents a normal, successful turn
// that happens to need a human, not an error. JOB_FAILURE, not TOOL_FAILURE,
// since 2026-08-17: "the orchestration crashed" is a different owner and a
// different fix from "the agent's own tool calls broke".
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AgentConfigService } from '../agent-config/agent-config.service';
import { toAgentTenantPolicy } from '../agent-config/agent-turn-policy';
import { describeNextOpening, isOpenAt } from '../agent-config/business-hours';
import { renderIntakeInstructions } from '../agent-config/intake-fields';
import { IntakeService } from '../conversation/intake.service';
import { TenantWebhookService } from '../outbound/tenant-webhook.service';
import { AgentRuntime } from '../agent/agent-runtime';
import type { AgentTurnResult } from '../agent/agent-turn.dto';
import type { TurnMedia } from '../agent/media/turn-media.dto';
import { AppLoggerService } from '../core';
import { buildConversationKey } from '../conversation/conversation-key';
import { ConversationLockService } from '../conversation/conversation-lock.service';
import { ConversationService } from '../conversation/conversation.service';
import { SummarizationService } from '../conversation/summarization.service';
import type { CoalescedRespondJobData } from '../conversation/coalesced-respond-job.dto';
import { CustomerLabelService } from '../customer/customer-label.service';
import { CustomerService } from '../customer/customer.service';
import { UsageService } from '../billing/usage.service';
import { TenantPolicyService } from '../onboarding/tenant-policy.service';
import { RESPOND_PATH_QUEUE } from '../queue/queue.providers';
import { AgentRunService } from '../telemetry/agent-run.service';
import { TicketEscalationService } from '../ticket/ticket-escalation.service';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { asksForHumanContact, holdingReplyFor } from './handover-holding-reply';
import { ChannelRegistry } from '../channel/channel-registry.service';
import { DEFAULT_CHANNEL } from '../channel/ports/channel-kind';
import { SocialChannelReconnectRequiredError } from '../meta-channel/social-channel.errors';

/** T17: "a tenant exceeding its configured cap gets a deterministic degrade (escalate-to-human, not silent LLM skip or unbounded spend)." Shaped exactly like a real AgentTurnResult so every downstream step (message recording, ticket creation, agent_runs recording) runs through its normal, single code path — this is the one and only place a turn can escalate WITHOUT AgentRuntime.respond() ever being called. */
function usageCapExceededResult(): AgentTurnResult {
  return {
    answer:
      "I'm going to connect you with a human agent who can help with this.",
    citedChunkIds: [],
    confidence: 0,
    escalate: true,
    escalationReason: 'USAGE_CAP_EXCEEDED',
    escalationSource: 'error_forced',
    isHallucination: false,
    // '' not a real prompt version — AgentTurnResult.promptVersion is
    // typed as a required string (AgentModule's own contract, not
    // nullable), and no prompt was ever assembled for this turn since
    // the LLM call is skipped entirely. AgentRunService.recordRun()'s own
    // `promptVersion` field IS nullable, and RespondPathProcessor maps
    // this empty string through as-is rather than inventing a fake
    // version string.
    promptVersion: '',
    telemetry: { inputTokens: 0, outputTokens: 0, latencyMs: 0, spans: {} },
  };
}

/**
 * F17/A11/A12: the degrade for "the customer sent us something and we could
 * not even get the bytes back out of storage".
 *
 * Same shape and same rationale as `usageCapExceededResult()` above — a real
 * AgentTurnResult so the messages, the ticket and the `agent_runs` row are all
 * written by their single normal code path. `escalation_reason` is decided at
 * the storage-failure call site that produces this, never re-derived later
 * (D13), and it is UNSUPPORTED_MEDIA rather than JOB_FAILURE because from the
 * customer's and the agent's side that is what happened: their attachment could
 * not be read.
 */
function unavailableMediaResult(): AgentTurnResult {
  return {
    answer:
      "I'm going to connect you with a human agent who can help with this.",
    citedChunkIds: [],
    confidence: 0,
    escalate: true,
    escalationReason: 'UNSUPPORTED_MEDIA',
    escalationSource: 'error_forced',
    isHallucination: false,
    escalationDetail: 'media_unreadable',
    // No prompt was assembled — the loop never ran. Same '' convention as
    // usageCapExceededResult().
    promptVersion: '',
    telemetry: { inputTokens: 0, outputTokens: 0, latencyMs: 0, spans: {} },
  };
}

/**
 * Default for how long a human handover survives without being handed back.
 * Per-agent as of F9 (`agent_versions.handover_auto_return_minutes`, which
 * defaults to this value); this constant is what a turn falls back to when
 * no agent could be resolved.
 *
 * A handover with no expiry is a conversation the agent has silently
 * abandoned: the person who claimed it goes home, the customer keeps
 * messaging, and nothing answers. An hour is long enough for a real
 * back-and-forth and short enough that a forgotten handover self-heals
 * before the customer gives up. Platform-owned rather than tenant-tunable
 * for now — see docs/SAAS_READINESS.md §3.
 */
export const HANDOVER_AUTO_RETURN_MINUTES = 60;

@Processor(RESPOND_PATH_QUEUE)
export class RespondPathProcessor extends WorkerHost {
  constructor(
    private readonly conversationLock: ConversationLockService,
    private readonly conversationService: ConversationService,
    private readonly customerService: CustomerService,
    private readonly customerLabelService: CustomerLabelService,
    private readonly tenantPolicyService: TenantPolicyService,
    private readonly agentRuntime: AgentRuntime,
    private readonly agentConfig: AgentConfigService,
    private readonly intake: IntakeService,
    private readonly outboundWebhooks: TenantWebhookService,
    private readonly summarization: SummarizationService,
    private readonly ticketEscalation: TicketEscalationService,
    private readonly agentRunService: AgentRunService,
    private readonly usageService: UsageService,
    private readonly channels: ChannelRegistry,
    // F17: reads back the attachment bytes MediaDownloadProcessor stored.
    private readonly storage: ObjectStorage,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<CoalescedRespondJobData>): Promise<void> {
    const { tenantId, from, messages: inboundMessages } = job.data;
    // Feature 16: 'whatsapp' is not a fallback guess — a job payload outlives
    // a deploy, and every job enqueued before this feature existed was in fact
    // a WhatsApp one. See CoalescedRespondJobData.channel.
    const channel = job.data.channel ?? DEFAULT_CHANNEL;
    const conversationKey = buildConversationKey(tenantId, from, channel);

    await this.conversationLock.withLock(
      tenantId,
      conversationKey,
      async () => {
        const customer = await this.customerService.getOrCreateByPhone(
          tenantId,
          from,
          channel,
        );
        const conversation =
          await this.conversationService.getOrCreateConversation(
            tenantId,
            from,
            job.data.channelAccountId ?? undefined,
            channel,
          );

        // WHICH agent is answering, and with WHICH published configuration
        // (F9). `agent_versions` is authoritative here; `tenant_policy` is
        // now the fallback for a tenant whose agents cannot be resolved —
        // several published agents with none bound to this number, which
        // stays possible until the console can bind one. Falling back rather
        // than throwing keeps such a tenant answering exactly as it did
        // before F9 instead of going dark on a routing gap.
        const agent = await this.agentConfig.resolveForPhoneNumber(
          tenantId,
          job.data.channelAccountId ?? null,
        );

        // A human has this conversation: record what the customer said and
        // stop. The agent answering over a person is the single worst
        // failure mode of a shared inbox — the customer gets two different
        // answers to the same question, and the human never learns it
        // happened. No LLM call and no agent_runs row (no turn took place);
        // the only things that may still happen are a deduplicated ticket
        // and one holding reply (ISSUE-001, see notifyHumanOfCustomerMessage).
        if (
          await this.isHandedToHuman(
            tenantId,
            conversation,
            agent?.config.handoverAutoReturnMinutes ??
              HANDOVER_AUTO_RETURN_MINUTES,
          )
        ) {
          await this.conversationService.recordInboundMessages(
            tenantId,
            conversation.id,
            inboundMessages,
            new Date(),
          );
          await this.notifyHumanOfCustomerMessage(
            job.data,
            customer.id,
            conversation,
          );
          this.logger.log(
            `respond-path skipped for conversation ${conversation.id}: handed to a human agent`,
            'RespondPathProcessor',
          );
          return;
        }

        // Launch billing backend (Lane A): the entitlement gate, checked
        // BEFORE any config resolution, media handling, or LLM work — not
        // just before the LLM call the way T17's usage-cap check is.
        // Distinct from that usage-cap check below: this is "does this
        // tenant have a working subscription AT ALL" (no row, an expired
        // trial, past_due/canceled/incomplete), not "is this tenant, who
        // DOES have one, over their configured cap." A billing-blocked
        // turn gets none of the normal machinery a within-plan turn gets —
        // no LLM call, no outbound channel send (unlike USAGE_CAP_EXCEEDED,
        // which still sends a "connecting you to a human" reply), and no
        // media download (kept out of this file entirely; see F17's own
        // media-download change for that queue) — only the inbound
        // message is stored and a single deduplicated ticket is opened, so
        // a human can follow up once billing is sorted out. Placed
        // immediately after the human-handover check (which must run
        // first regardless of billing — a human already owns this
        // conversation either way) and BEFORE tenant-policy resolution,
        // the recent-message read, and AgentRuntime.respond() — the most
        // expensive work this method does. `agent` above is resolved
        // ahead of this point only because isHandedToHuman() itself needs
        // its per-agent handoverAutoReturnMinutes; that one resolution is
        // unavoidable, everything after it is skipped.
        const entitlement = await this.usageService.checkEntitlement(tenantId);
        if (!entitlement.allowed) {
          await this.conversationService.recordInboundMessages(
            tenantId,
            conversation.id,
            inboundMessages,
            new Date(),
          );
          const bspMessageIds = inboundMessages
            .map((message) => message.providerMessageId)
            .join(', ');
          await this.ticketEscalation.createTicket({
            tenantId,
            customerId: customer.id,
            conversationId: conversation.id,
            escalationReason: 'BILLING_BLOCKED',
            note: `conversation ${conversation.id} (bspMessageIds=[${bspMessageIds}]): tenant is not entitled to AI replies (${entitlement.blockReason ?? 'unknown'}) — inbound message stored, no reply sent.`,
          });
          this.logger.warn(
            `respond-path blocked for tenant ${tenantId} conversation ${conversation.id}: ${entitlement.blockReason ?? 'unknown'}`,
            'RespondPathProcessor',
          );
          return;
        }

        const tenantPolicy = agent
          ? null
          : await this.tenantPolicyService.getForTenant(tenantId);
        if (!agent && !tenantPolicy) {
          throw new Error(
            `No published agent and no tenant_policy row for tenant ${tenantId} — cannot run a turn without configuration (F9/T15).`,
          );
        }
        if (!agent) {
          this.logger.warn(
            `tenant ${tenantId} has no resolvable published agent — running this turn from the legacy tenant_policy row`,
            'RespondPathProcessor',
          );
        }

        // One shape, whichever source it came from, so nothing downstream has
        // to know which one won. Shared with the comment pipeline (Gulf T8).
        // Non-null: the guard above threw when neither source exists.
        const policy = toAgentTenantPolicy(agent, tenantPolicy)!;

        // Read PRIOR state before recording this turn's messages, so the
        // just-arrived batch isn't duplicated as both `currentMessage` and
        // the tail of `recentMessages`.
        const recentMessages = await this.conversationService.getRecentWindow(
          tenantId,
          conversation.id,
        );
        const currentMessage = inboundMessages
          .map((message) => message.text)
          .join('\n');

        // F17/A11/A12: fetch the bytes for any attachment on this turn. Done
        // HERE, not in AgentModule, for the same reason retrieval scoping is:
        // storage addressing is the channel/persistence side's knowledge, and
        // the agent takes bytes.
        //
        // A fetch that fails does not fail the job and does not silently drop
        // the message — it produces the same deterministic degrade every other
        // unanswerable-media path produces, an UNSUPPORTED_MEDIA escalation
        // that still writes its messages, its ticket and its agent_runs row.
        let turnMedia: TurnMedia[];
        let mediaUnavailable = false;
        try {
          turnMedia = await this.loadTurnMedia(inboundMessages);
        } catch (error) {
          this.logger.error(
            `respond-path could not load media for conversation ${conversation.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'RespondPathProcessor',
          );
          turnMedia = [];
          mediaUnavailable = true;
        }

        // T17: "a tenant exceeding its configured cap gets a deterministic
        // degrade... never unbounded spend." A tenant with no active/
        // trialing subscription (hasEnforceablePlan: false) is never
        // degraded — there's nothing to enforce against (default
        // BILLING_PROVIDER=none in most environments, including this
        // one). Reuses the SAME `entitlement` result the Lane-A gate above
        // already fetched (that check already returned early for a
        // billing-blocked tenant, so reaching this line means
        // `entitlement.allowed` is true) rather than a second
        // checkEntitlement() call/query.
        const overEntitlement =
          entitlement.hasEnforceablePlan &&
          (entitlement.overMessageLimit || entitlement.overSpendCap);

        // Only ever set while the tenant is closed. The agent keeps
        // answering from the knowledge base either way; this changes what it
        // promises about a human.
        const closedNow =
          agent !== null &&
          !isOpenAt(
            agent.config.businessHours,
            agent.config.timezone,
            new Date(),
          );

        const result = overEntitlement
          ? usageCapExceededResult()
          : mediaUnavailable
            ? unavailableMediaResult()
            : await this.agentRuntime.respond({
                tenantId,
                // F25 D6.1 / F26 D4: the turn identity tools are authorized
                // and executed under. All three are already resolved above —
                // nothing new is looked up for them.
                conversationId: conversation.id,
                customerId: customer.id,
                // The coalesced burst's own BullMQ job id: stable across
                // retries of THIS job, which is exactly the property an
                // idempotency key derived from it needs (a fresh UUID per
                // attempt would make a retry look like a new turn). Null
                // only in the theoretical case of a job with no id.
                turnId: job.id ?? null,
                conversationSummary: conversation.rollingSummary,
                recentMessages,
                currentMessage,
                tenantPolicy: {
                  ...policy,
                  ...(closedNow && agent
                    ? {
                        outOfHours: {
                          openingHours: describeNextOpening(
                            agent.config.businessHours,
                            agent.config.timezone,
                          ),
                          response: agent.config.outOfHoursResponse,
                        },
                      }
                    : {}),
                },
                // Empty for an unscoped agent (and for the legacy fallback),
                // which retrieval reads as "the whole knowledge base".
                kbDocumentIds: agent?.config.kbDocumentIds ?? [],
                intakeInstructions: agent
                  ? renderIntakeInstructions(agent.config.intakeFields)
                  : undefined,
                // F17: empty on a text turn, which is every turn that was
                // possible before this feature.
                media: turnMedia,
              });

        await this.conversationService.recordInboundMessages(
          tenantId,
          conversation.id,
          inboundMessages,
          new Date(),
        );
        const assistantMessageId =
          await this.conversationService.recordAssistantMessage(
            tenantId,
            conversation.id,
            result.answer,
          );

        // Recorded before delivery: what the customer told us is worth
        // keeping even if the reply never reaches them.
        if (agent && result.intake) {
          const { stored, ignored } = await this.intake.record({
            tenantId,
            conversationId: conversation.id,
            customerId: customer.id,
            fields: agent.config.intakeFields,
            captured: result.intake,
          });
          if (stored.length > 0) {
            // Fire-and-forget by design: this is a customer's turn, and a
            // tenant's endpoint must never add latency to it or fail it. The
            // service queues and swallows its own errors.
            // `.catch()` at the call site, not just inside the service: a
            // bare `void promise` turns any rejection into an unhandled one,
            // which takes the whole worker process down. Fire-and-forget has
            // to mean forgotten, including when it fails.
            void this.outboundWebhooks
              .emit(tenantId, 'conversation.intake_captured', {
                conversation: {
                  id: conversation.id,
                  customerPhone: from,
                },
                intake: Object.fromEntries(
                  stored.map((key) => [key, result.intake?.[key]]),
                ),
                capturedAt: new Date().toISOString(),
              })
              .catch((error: unknown) => {
                this.logger.error(
                  `failed to queue an intake webhook for conversation ${conversation.id}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  'RespondPathProcessor',
                );
              });
          }
          if (ignored.length > 0) {
            this.logger.warn(
              `agent reported intake keys nobody configured on conversation ${conversation.id}: ${ignored.join(', ')}`,
              'RespondPathProcessor',
            );
          }
        }

        const delivery = await this.deliverAnswer(job.data, result.answer);
        if (delivery.providerMessageId) {
          // The row is written before the send and learns its BSP id here:
          // without that id, a later delivery/read/failure callback has
          // nothing to match on and the message's fate is unknowable.
          await this.conversationService.attachOutboundDelivery(
            tenantId,
            assistantMessageId,
            delivery.providerMessageId,
          );
        }

        let ticketId: string | null = null;
        if (result.escalate) {
          const bspMessageIds = inboundMessages
            .map((message) => message.providerMessageId)
            .join(', ');
          const ticket = await this.ticketEscalation.createTicket({
            tenantId,
            customerId: customer.id,
            conversationId: conversation.id,
            escalationReason: result.escalationReason ?? 'LLM_ERROR',
            note: `conversation ${conversation.id} (bspMessageIds=[${bspMessageIds}]) escalated: ${
              result.escalationReason ?? 'unknown'
            }`,
            confidence: result.confidence,
            citedChunkIds: result.citedChunkIds,
          });
          ticketId = ticket.id;
        }

        // A failed SEND is escalated, not retried. Retrying the job would
        // re-run the entire turn — a second LLM call, a second pair of
        // recorded messages, a second agent_runs row — to fix what is only
        // a delivery problem, and would do it again on every attempt. The
        // customer is waiting on a human either way, so the deterministic
        // degrade (same shape as D2's breaker and T17's cap) is a ticket.
        // A dedicated outbound-delivery queue with its own retry is the
        // right long-term fix; see docs/HANDOFF.md.
        const undeliverable = delivery.attempted && !delivery.sent;
        if (undeliverable && !ticketId) {
          const ticket = await this.ticketEscalation.createTicket({
            tenantId,
            customerId: customer.id,
            conversationId: conversation.id,
            escalationReason: 'DELIVERY_FAILURE',
            note: `conversation ${conversation.id}: the agent produced an answer but delivery failed (${delivery.error ?? 'unknown error'}) — the customer never received it.`,
            confidence: result.confidence,
            citedChunkIds: result.citedChunkIds,
          });
          ticketId = ticket.id;
        }

        // Feature 18 (Intent Labeling): A5's decision for this turn, reused as
        // the customer's label. Inline and awaited — the exit criterion is
        // "within one respond-path cycle, no batch job, no lag", so this is
        // not a queued follow-up and not fire-and-forget.
        //
        // It is deliberately NOT wrapped in a try/catch. A throw here fails
        // the job exactly like the `recordRun()` call below it already does;
        // swallowing the error would leave the console showing a stale label
        // with nothing anywhere saying why, which is the failure mode the
        // "no lag" criterion exists to rule out.
        //
        // The override-wins rule is enforced inside applyAgentSignal()'s
        // single upsert statement, not by checking here first — see that
        // method for why a read-then-write loses the race against a human
        // overriding mid-turn.
        //
        // `escalationSource` is passed through untouched: an `error_forced`
        // escalation (our provider broke, our send failed, the tenant hit its
        // cap) says nothing about the customer, and the derivation drops it
        // rather than relabelling everyone during an outage.
        await this.customerLabelService.applyAgentSignal(
          tenantId,
          customer.id,
          {
            escalate: result.escalate,
            escalationReason: result.escalationReason,
            escalationSource: result.escalationSource,
          },
        );

        // A8: exactly one agent_runs row per respond-path invocation —
        // success or escalation, both handled here; the T11 exhausted-
        // retry error path writes its own row in onFailed() below.
        //
        // An undelivered answer from an OTHERWISE-CLEAN turn is not a
        // success. That row used to be written as status='success' with
        // escalation_reason=null while a DELIVERY_FAILURE ticket sat right next
        // to it pointing at the same conversation: A9's resolution rate
        // counted the turn as handled, the escalation mix never saw it, and
        // the only trace that a customer never got their answer was a ticket
        // none of the metrics read. `error` (not `escalated`) matches the
        // convention onFailed() already uses for the job-failure path.
        //
        // A turn that ALREADY escalated keeps its own status and reason. The
        // agent's reason (CUSTOMER_DISTRESS, USAGE_CAP_EXCEEDED, ...) is the
        // one that explains why a human is now involved, and a delivery
        // problem must not overwrite it — a human is taking the conversation
        // over either way, which is exactly what `escalated` records. The
        // delivery failure is still recorded, on `errorMessage`, so it is
        // never lost.
        //
        // D13 "set exactly once at the call site that decides": the
        // escalation_reason for an undelivered answer is decided HERE, by
        // the delivery check above — never re-derived from the ticket.
        const deliveryForcedEscalation = undeliverable && !result.escalate;
        await this.agentRunService.recordRun({
          tenantId,
          conversationId: conversation.id,
          ticketId,
          agentId: agent?.agentId ?? null,
          agentConfigVersion: agent?.configVersion ?? null,
          status: deliveryForcedEscalation
            ? 'error'
            : result.escalate
              ? 'escalated'
              : 'success',
          escalationReason: deliveryForcedEscalation
            ? 'DELIVERY_FAILURE'
            : result.escalationReason,
          escalationSource: deliveryForcedEscalation
            ? 'error_forced'
            : result.escalationSource,
          // A8: the loop's own diagnostic, persisted rather than dropped —
          // `escalationReason` alone folds five different loop failures into
          // LLM_ERROR, so without this column "how many turns did we lose to
          // the deadline vs. the provider yesterday" is unanswerable from
          // production data. Passed straight through; never inferred here.
          escalationDetail: result.escalationDetail ?? null,
          confidence: result.confidence,
          inputTokens: result.telemetry.inputTokens,
          outputTokens: result.telemetry.outputTokens,
          latencyMs: result.telemetry.latencyMs,
          spans: result.telemetry.spans,
          promptVersion: result.promptVersion || null,
          errorMessage: undeliverable
            ? `Channel delivery failed: ${delivery.error ?? 'unknown error'}`
            : null,
        });

        // T9: "latency metric emitted per response" — a real-time,
        // per-turn signal independent of the periodic p95 sweep
        // (AlertingModule/LatencyBudgetCheckService), which only fires on
        // a sustained budget breach across many turns, not a single slow
        // one.
        this.logger.log(
          `respond-path turn for tenant ${tenantId} conversation ${conversation.id}: ${result.telemetry.latencyMs}ms (status=${turnStatus(result.escalate, undeliverable)})`,
          'RespondPathProcessor',
        );

        await this.summarization.maybeScheduleSummarization(
          tenantId,
          conversation.id,
        );
      },
    );
  }

  /**
   * Sends the computed answer back to the customer over WhatsApp — the
   * last step of the loop, and the one that was impossible until T0 was
   * signed off. Never throws: a delivery failure is turned into a ticket
   * by the caller (see the comment at that call site), not a job failure.
   */
  /**
   * ISSUE-001: the agent stays silent during a human handover, but a customer
   * who asks for a person (or who has had no human reply since the handover)
   * must not be ignored. Opens/bumps the conversation's single deduplicated
   * ticket so a human is alerted, and sends at most ONE short holding reply
   * per handover (`handoverHoldingReplyAt`, cleared when a handover starts or
   * ends). Never throws: a failed alert/send must not fail the job, since the
   * inbound message is already stored and a retry would only repeat it.
   */
  private async notifyHumanOfCustomerMessage(
    jobData: CoalescedRespondJobData,
    customerId: string,
    conversation: {
      id: string;
      handoverAt: Date | null;
      handoverHoldingReplyAt?: Date | null;
    },
  ): Promise<void> {
    const { tenantId, messages: inbound } = jobData;
    const customerText = inbound.map((message) => message.text).join('\n');
    try {
      const requestedHuman = asksForHumanContact(customerText);
      const humanReplied =
        !!conversation.handoverAt &&
        (await this.conversationService.hasHumanReplySince(
          tenantId,
          conversation.id,
          conversation.handoverAt,
        ));
      if (!requestedHuman && humanReplied) return;

      const bspMessageIds = inbound
        .map((message) => message.providerMessageId)
        .join(', ');
      await this.ticketEscalation.createTicket({
        tenantId,
        customerId,
        conversationId: conversation.id,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        note: `conversation ${conversation.id} (bspMessageIds=[${bspMessageIds}]): customer wrote during human handover (${requestedHuman ? 'asked for a person' : 'no human reply yet'}) — agent stayed silent.`,
      });

      if (conversation.handoverHoldingReplyAt) return;
      const reply = holdingReplyFor(customerText);
      const delivery = await this.deliverAnswer(jobData, reply);
      if (!delivery.sent) return;
      const messageId = await this.conversationService.recordAssistantMessage(
        tenantId,
        conversation.id,
        reply,
      );
      if (delivery.providerMessageId) {
        await this.conversationService.attachOutboundDelivery(
          tenantId,
          messageId,
          delivery.providerMessageId,
        );
      }
      await this.conversationService.markHandoverHoldingReplySent(
        tenantId,
        conversation.id,
        new Date(),
      );
    } catch (error) {
      this.logger.error(
        `respond-path could not alert a human for conversation ${conversation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'RespondPathProcessor',
      );
    }
  }

  /**
   * True when the agent must stay silent. A handover older than
   * HANDOVER_AUTO_RETURN_MINUTES is handed back here rather than by a
   * scheduler: the check has to happen on this path anyway, and doing the
   * return inline means the very message that woke us is answered instead of
   * waiting for the next tick.
   */
  private async isHandedToHuman(
    tenantId: string,
    conversation: {
      id: string;
      handoverState: string;
      handoverAt: Date | null;
    },
    autoReturnMinutes: number,
  ): Promise<boolean> {
    if (conversation.handoverState !== 'human') return false;

    const now = new Date();
    const staleAfterMs = autoReturnMinutes * 60_000;
    // A 'human' state with no handoverAt cannot be aged out and would trap
    // the conversation forever — treat it as stale and return it.
    const stale =
      !conversation.handoverAt ||
      now.getTime() - conversation.handoverAt.getTime() > staleAfterMs;

    if (!stale) return true;

    await this.conversationService.returnToAgent(
      tenantId,
      conversation.id,
      now,
    );
    this.logger.warn(
      `conversation ${conversation.id} auto-returned to the agent after ${autoReturnMinutes}m without being handed back`,
      'RespondPathProcessor',
    );
    return false;
  }

  /**
   * F17: turns this turn's stored attachments into the bytes AgentModule takes.
   *
   * Rethrows on a storage failure rather than skipping the attachment: an
   * "answer" produced from a photo we could not load would be an answer to a
   * question nobody asked. The caller degrades the whole turn instead.
   */
  private async loadTurnMedia(
    inboundMessages: CoalescedRespondJobData['messages'],
  ): Promise<TurnMedia[]> {
    const withMedia = inboundMessages.filter((message) => message.media);
    if (withMedia.length === 0) return [];

    return Promise.all(
      withMedia.map(async (message) => {
        const media = message.media!;
        const bytes = await this.storage.download(media.storageKey);
        return {
          kind: media.kind,
          mimeType: media.mimeType,
          bytes,
          messageId: media.messageId,
        };
      }),
    );
  }

  private async deliverAnswer(
    jobData: CoalescedRespondJobData,
    answer: string,
  ): Promise<{
    attempted: boolean;
    sent: boolean;
    providerMessageId?: string;
    error?: string;
  }> {
    if (!jobData.channelAccountId) {
      // Pre-cutover job (see CoalescedRespondJobData.channelAccountId).
      this.logger.warn(
        `respond-path job for tenant ${jobData.tenantId} carries no channelAccountId — skipping delivery. Expected only for jobs enqueued before the outbound-send cutover.`,
        'RespondPathProcessor',
      );
      return { attempted: false, sent: false };
    }

    try {
      // Feature 16: a REGISTRY LOOKUP on the channel already recorded in the
      // payload, not a branch on it. Adding Instagram added an entry to the
      // registry and changed nothing in this method — which is the same
      // property T0's BspAdapter port gave us when a second WhatsApp vendor
      // appeared, now generalized past WhatsApp.
      const adapter = this.channels.for(jobData.channel ?? DEFAULT_CHANNEL);
      const { providerMessageId } = await adapter.sendText({
        channelAccountId: jobData.channelAccountId,
        to: jobData.from,
        body: answer,
      });
      this.logger.log(
        `respond-path delivered reply ${providerMessageId} to ${jobData.from} for tenant ${jobData.tenantId}`,
        'RespondPathProcessor',
      );
      return { attempted: true, sent: true, providerMessageId };
    } catch (error) {
      if (error instanceof SocialChannelReconnectRequiredError) {
        // Feature 16's central degrade, reached rather than described: the
        // channel's Meta token is dead and could not be renewed. This lands
        // in the same DELIVERY_FAILURE path every other send failure does, so
        // a human answers the customer — the ONE thing that must never happen
        // is the reply quietly evaporating. The tenant-facing signal is the
        // channel's `reconnect_required` state, which their console reads.
        this.logger.error(
          `respond-path could not deliver for tenant ${jobData.tenantId}: ${error.message}`,
          undefined,
          'RespondPathProcessor',
        );
        return { attempted: true, sent: false, error: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `respond-path failed to deliver a reply for tenant ${jobData.tenantId}: ${message}`,
        'RespondPathProcessor',
      );
      return { attempted: true, sent: false, error: message };
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<CoalescedRespondJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= maxAttempts;

    this.logger.warn(
      `respond-path job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      'RespondPathProcessor',
    );

    if (!exhausted) return;

    // A job whose payload isn't the current CoalescedRespondJobData shape
    // (a pre-T10 one-message-per-job entry still sitting in Redis, or any
    // poison/hand-enqueued job) can't be escalated — there's no tenant to
    // open a ticket under. Bail loudly instead of dereferencing: an
    // exception thrown from inside this failure handler is an unhandled
    // rejection that takes the whole process down, HTTP routes included.
    const { tenantId, from, messages } = job.data;
    if (!tenantId || !from || !Array.isArray(messages)) {
      this.logger.error(
        `respond-path job ${job.id} has an unrecognized payload shape and cannot be escalated; dropping after ${maxAttempts} attempts`,
        undefined,
        'RespondPathProcessor',
      );
      return;
    }

    const channel = job.data.channel ?? DEFAULT_CHANNEL;
    const customer = await this.customerService.getOrCreateByPhone(
      tenantId,
      from,
      channel,
    );
    const conversation = await this.conversationService.getOrCreateConversation(
      tenantId,
      from,
      job.data.channelAccountId ?? undefined,
      channel,
    );
    const bspMessageIds = job.data.messages
      .map((message) => message.providerMessageId)
      .join(', ');
    const ticket = await this.ticketEscalation.createTicket({
      tenantId,
      customerId: customer.id,
      conversationId: conversation.id,
      escalationReason: 'JOB_FAILURE',
      note: `respond-path job ${job.id} (bspMessageIds=[${bspMessageIds}]) exhausted ${maxAttempts} attempts: ${error.message}`,
    });

    // Attributed like any other run. A job failure is exactly the kind of
    // outcome a tenant needs to see against the agent it happened on —
    // leaving these null would make per-agent error rates read as zero.
    const agent = await this.agentConfig.resolveForPhoneNumber(
      tenantId,
      job.data.channelAccountId ?? null,
    );

    // A8: the error-path counterpart to process()'s success/escalated
    // recordRun() call — AgentRuntime never got to (or never finished)
    // producing a result at all here, so there's no real token/span/
    // confidence data to report; zeros/nulls are honest about that,
    // never a guessed non-zero value.
    await this.agentRunService.recordRun({
      tenantId,
      conversationId: conversation.id,
      ticketId: ticket.id,
      agentId: agent?.agentId ?? null,
      agentConfigVersion: agent?.configVersion ?? null,
      status: 'error',
      escalationReason: 'JOB_FAILURE',
      escalationSource: 'error_forced',
      // The turn never reached (or never finished) the bounded loop, so no
      // loop branch decided anything — null, not a guessed detail.
      escalationDetail: null,
      confidence: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      spans: {},
      promptVersion: null,
      errorMessage: error.message,
    });
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `respond-path worker connection error: ${error.message}`,
      error.stack,
      'RespondPathProcessor',
    );
  }
}

/**
 * What actually happened this turn, for the per-turn latency log.
 *
 * Deriving this from `escalate` alone reports "success" for a turn whose
 * answer never reached the customer — the loop was clean, but delivery
 * failed, and the row written to `agent_runs` says `error` while the log
 * says success. The log has to agree with the outcome, not with the half of
 * it that went well.
 */
function turnStatus(escalated: boolean, undeliverable: boolean): string {
  if (undeliverable) return 'undelivered';
  return escalated ? 'escalated' : 'success';
}
