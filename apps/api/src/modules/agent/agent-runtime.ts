// A4: AgentRuntime.respond(turn) — the bounded loop (D6). Ties together
// every prior Feature 3 slice: A1 (RetrievalSearchService) for L4 + the
// D12 forbidden-topic check's embedding, A3 (PromptAssemblyService) for
// the seven layers, A0 (LlmProvider) for the actual completion, A6
// (GuardrailModule) for the terminal-call schema + citation verification,
// A5 (computeEscalationDecision) for D10's composite confidence. T1's
// RESCUE_POLICY drives every retry/escalation decision inside the loop —
// this class never hardcodes "retry twice" itself, it looks the answer up
// per error code.
//
// Bounds (agent-loop-config.ts): ≤2 tool round-trips, ≤1 corrective retry
// (shared across "malformed tool call," "invalid respond payload," and
// "didn't call respond at all" — one budget, not three), plus a global
// wall-clock deadline checked before every provider call. Exceeding any of
// these terminates the turn with an escalation, never an unbounded loop or
// a silent failure (D2's whole point) — with ONE exception: once a tool has
// produced a result this turn, a deadline hit buys exactly one final
// `respond` call inside a hard cap (FINAL_RESPOND_GRACE_MS), so a customer is
// not left uninformed of an order that was already written. See
// finalRespondAfterDeadline().
import { Injectable } from '@nestjs/common';
import {
  AgentError,
  type EscalationReason,
  type EscalationSource,
  KBNotIndexed,
  LLMMalformedToolCall,
  LLMTimeout,
  ToolScopeViolation,
  getRescuePolicy,
} from '@repo/errors';
import { AppLoggerService, Clock, Sleep } from '../core';
import { AppConfigService } from '../core/config/app-config.service';
import { ConversationService } from '../conversation/conversation.service';
import { AnswerGroundingVerifierService } from '../guardrail/answer-grounding-verifier.service';
import { ForbiddenTopicCheckerService } from '../guardrail/forbidden-topic-checker.service';
import {
  parseRespondPayload,
  type RespondPayload,
} from '../guardrail/respond-payload.schema';
import { verifyCitations } from '../guardrail/citation-verification';
import {
  LlmProvider,
  VisionLlmProvider,
  type LlmImageAttachment,
  type LlmMessage,
  type LlmToolDefinition,
  type LlmToolRequest,
  type LlmToolResult,
} from '../llm/ports/llm-provider.port';
import { MediaUnderstandingService } from './media/media-understanding.service';
import type { MediaUnderstanding } from './media/turn-media.dto';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { PROMPT_VERSION } from '../prompt/prompt-version';
import {
  RetrievalSearchService,
  type RetrievalSearchResult,
  type RetrievedChunkResult,
} from '../retrieval/retrieval-search.service';
import { recordRetrievalSubSpans } from './retrieval-sub-spans';
import { parseRespondPayloadFromText } from './respond-text-fallback';
import { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { ToolExecutionService } from '../tool-execution/tool-execution.service';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';
import {
  answeredToolCallMessages,
  correctiveInstructionMessage,
} from './agent-loop-messages';
import {
  FINAL_RESPOND_GRACE_MS,
  GROUNDING_DRAFT_LOG_CHARS,
  MAX_CORRECTIVE_RETRIES,
  MAX_TOOL_ROUND_TRIPS,
} from './agent-loop-config';
import { AgentRunTelemetry } from './agent-run-telemetry';
import { buildBookingConfirmation } from './booking-confirmation';
import { buildOrderConfirmation } from './order-confirmation';
import { reportsCustomerGrievance } from '../guardrail/customer-grievance';
import { isLateDeliveryComplaint } from '../guardrail/late-delivery-complaint';
import { trackOrderFoundNothing } from '../guardrail/shipment-not-found';
import {
  reportsSafetyRisk,
  safetyHandoffAnswer,
} from '../guardrail/safety-risk';
import {
  computeEscalationDecision,
  dropUnresolvableCitations,
} from './escalation-decision';
import {
  RESPOND_TOOL_DEFINITION,
  RESPOND_TOOL_NAME,
} from './respond-tool-definition';
import type {
  AgentTurnInput,
  AgentTurnResult,
  EscalationDetail,
} from './agent-turn.dto';

/** The turn's wall-clock bound cut a provider call short (see callProviderOnce). An LLMTimeout so it reads as one everywhere, but distinguishable: it means "out of time", not "the provider is slow". */
class CallDeadlineExceeded extends LLMTimeout {
  constructor() {
    super('provider call exceeded the agent loop deadline');
  }
}

interface LoopContext {
  tenantId: string;
  /**
   * F25 D6.1 / F26 D4: built ONCE per turn in respond() from the fields the
   * caller already resolved, and passed as the SAME object to both
   * `authorize()` and `execute()` — an authorization decision made for one
   * turn must not be spendable on another.
   */
  toolContext: ToolExecutionContext;
  /** The customer's message this turn — the grounding check needs the QUESTION, not just the answer, to judge whether the cited passages are about the thing actually asked. */
  currentMessage: string;
  tools: LlmToolDefinition[];
  retrievedChunks: RetrievedChunkResult[];
  confidenceThreshold: number;
  /** A11/A12 (D10 extension): how well this turn's non-text input was understood, 1 for a text-only turn. Caps the composite confidence — see computeEscalationDecision(). */
  modalityConfidence: number;
  /** A11: which binding answers this turn — the vision-capable one when the turn carries images the loop must actually see, the normal chat binding otherwise. */
  provider: LlmProvider;
  promptVersion: string;
  deadlineAtMs: number;
  /** True only for the single post-deadline `respond` call finalRespondAfterDeadline() makes; `deadlineAtMs` is then the grace hard cap. */
  inFinalGrace: boolean;
  /** A8: request-scoped, threaded explicitly (never stored on `this` — AgentRuntime is a shared singleton across concurrent turns). */
  telemetry: AgentRunTelemetry;
  startMs: number;
}

@Injectable()
export class AgentRuntime {
  constructor(
    private readonly promptAssembly: PromptAssemblyService,
    private readonly llmProvider: LlmProvider,
    private readonly visionProvider: VisionLlmProvider,
    private readonly mediaUnderstanding: MediaUnderstandingService,
    private readonly retrievalSearch: RetrievalSearchService,
    private readonly forbiddenTopicChecker: ForbiddenTopicCheckerService,
    private readonly groundingVerifier: AnswerGroundingVerifierService,
    private readonly toolRegistry: TenantToolRegistryService,
    private readonly toolExecution: ToolExecutionService,
    private readonly conversations: ConversationService,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    private readonly logger: AppLoggerService,
  ) {}

  async respond(input: AgentTurnInput): Promise<AgentTurnResult> {
    const startMs = this.clock.nowMs();
    const telemetry = new AgentRunTelemetry();

    // A11/A12: the modality stage runs FIRST, ahead of retrieval, because
    // everything downstream is text-driven — a voice note has to become words
    // before there is a query to search with, a forbidden-topic embedding to
    // compute, or a prompt to assemble. A turn with no attachments skips this
    // entirely and is byte-for-byte the pre-Feature-17 path.
    //
    // D3 (2026-09-17, launch-blocking): AGENT_LOOP_DEADLINE_MS is the bounded
    // LOOP's own wall clock (see LoopContext's doc comment — "checked before
    // every provider call"), not the whole turn's. It used to be computed
    // BEFORE this stage ran, so a slow vision/ASR call (its own network round
    // trip to the self-hosted host, no timeout of its own today) silently ate
    // into the loop's budget before the loop ever started — a media turn
    // could open the loop already past its deadline and escalate
    // LLM_ERROR/deadline_exceeded despite every actual LLM call being fast.
    // Computing it AFTER the pre-pass resolves (success or throw) — and, since
    // cycle 3, after retrieval and the intake guardrails too (see the call
    // site right before runLoop) — fixes that without adding a second budget
    // concept: the deadline covers the part AGENT_LOOP_DEADLINE_MS actually
    // documents, the provider round trips, rather than paying for the
    // pre-pass twice. The alternative (a separate
    // MEDIA_UNDERSTANDING_DEADLINE_MS budget) was rejected: it would add a
    // second env var and a second timeout-vs-escalation policy for a stage
    // that already has its own bounded retry (transcribeWithPolicy) and its
    // own failure-to-escalation path (MediaUnreadable/TranscriptionFailed
    // below) — nothing here needs a second clock, only the right start line
    // for the one clock that exists.
    let understanding: MediaUnderstanding | null = null;
    if (input.media && input.media.length > 0) {
      const mediaStartMs = this.clock.nowMs();
      try {
        understanding = await this.mediaUnderstanding.understand(input.media);
      } catch (error) {
        telemetry.addSpan('mediaMs', this.clock.nowMs() - mediaStartMs);
        if (!(error instanceof AgentError)) throw error;
        // T3's amended matrix, at its single call site: media we genuinely
        // cannot read still hard-escalates as UNSUPPORTED_MEDIA — corrupt
        // bytes, a mime type outside the whitelist, an oversized payload, a
        // failed or unconfigured ASR/vision binding. `escalation_reason` is
        // decided here and never re-derived downstream (D13).
        const policy = getRescuePolicy(error.code);
        return this.terminalEscalation(
          policy.escalationReason ?? 'UNSUPPORTED_MEDIA',
          'error_forced',
          PROMPT_VERSION,
          telemetry,
          startMs,
          error.code === 'TRANSCRIPTION_FAILED'
            ? 'transcription_failed'
            : 'media_unreadable',
        );
      }
      telemetry.addSpan('mediaMs', this.clock.nowMs() - mediaStartMs);

      // Best-effort: the transcript already did its job (it's in
      // `understanding.derivedText`, headed into the prompt below) —
      // persisting a copy for the inbox to display must not be able to fail
      // the customer's turn. Logged, not swallowed silently.
      if (understanding.transcripts.length > 0) {
        try {
          await this.conversations.saveMediaTranscripts(
            input.tenantId,
            understanding.transcripts,
          );
        } catch (error) {
          this.logger.error(
            `failed to persist media transcript(s) for tenant ${input.tenantId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            AgentRuntime.name,
          );
        }
      }
    }

    // One message for the whole turn, whatever modality it arrived in: the
    // caption/text the customer typed plus the transcript/description derived
    // from their attachment. Retrieval, the D12 forbidden-topic check, L6, and
    // A6's grounding question all read THIS string, so no guardrail can be
    // bypassed by sending a photo instead of typing (A6, extended to
    // vision/voice by construction rather than by a parallel check).
    const currentMessage = composeCurrentMessage(
      input.currentMessage,
      understanding,
    );

    // Read before retrieval because it decides what an empty knowledge base
    // means. With no enabled tools, nothing but the KB could answer, so an
    // empty index stays a terminal KB_NOT_INDEXED. With tools (a synced
    // catalog, orders, tracking), the turn runs with zero chunks: the tools are
    // the evidence, and escalating here made them unreachable for every
    // merchant who had not written a KB yet (L2 eval, 2026-09-28).
    const toolSchemas = await this.toolRegistry.getPromptToolSchemas(
      input.tenantId,
    );

    let retrieval: RetrievalSearchResult;
    try {
      const retrievalStartMs = this.clock.nowMs();
      retrieval = await this.retrievalSearch.search(
        input.tenantId,
        currentMessage,
        input.tenantPolicy.rerankEnabled,
        input.kbDocumentIds,
        { allowEmpty: toolSchemas.length > 0 },
      );
      telemetry.addSpan('retrievalMs', this.clock.nowMs() - retrievalStartMs);
      // P0.3: retrievalMs on its own cannot say WHICH part of retrieval was
      // slow, so the phase breakdown the service already measured is recorded
      // alongside it. Pure telemetry — nothing in the loop reads these.
      recordRetrievalSubSpans(telemetry, retrieval.timings);
    } catch (error) {
      if (error instanceof KBNotIndexed) {
        return this.terminalEscalation(
          'KB_NOT_INDEXED',
          'error_forced',
          PROMPT_VERSION,
          telemetry,
          startMs,
          'kb_not_indexed',
        );
      }
      throw error;
    }

    // D12: forbidden-topic check at intake, reusing retrieval's query
    // embedding — never a second embed call for the same message.
    const guardrailStartMs = this.clock.nowMs();
    const forbiddenMatch = await this.forbiddenTopicChecker.check(
      retrieval.queryEmbedding,
      input.tenantPolicy.forbiddenTopics,
    );
    telemetry.addSpan('guardrailMs', this.clock.nowMs() - guardrailStartMs);
    if (forbiddenMatch.isForbidden) {
      return this.terminalEscalation(
        'FORBIDDEN_TOPIC',
        'agent_decision',
        PROMPT_VERSION,
        telemetry,
        startMs,
        'forbidden_topic',
      );
    }

    const assembled = this.promptAssembly.assemble({
      tenantPersona: input.tenantPolicy.tonePersonaOverride,
      tenantPolicy: {
        forbiddenTopics: input.tenantPolicy.forbiddenTopics,
        confidenceThreshold: input.tenantPolicy.confidenceThreshold,
        intakeInstructions: input.intakeInstructions,
      },
      toolSchemas,
      retrievedChunks: retrieval.chunks.map((chunk, index) => ({
        id: citationHandle(index),
        content: chunk.content,
      })),
      conversationSummary: input.conversationSummary,
      recentMessages: input.recentMessages,
      currentMessage,
    });

    const tools: LlmToolDefinition[] = [
      ...assembled.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
      RESPOND_TOOL_DEFINITION,
    ];

    // Cycle 3 (2026-09-30): the loop's clock starts HERE, net of everything
    // before the first provider call. It used to start before retrieval, so a
    // slow embed/rerank (3.3s on one L1 turn) came straight out of the 8s the
    // model had left, and a turn whose provider calls were all normal missed
    // the deadline (and, after create_order, the customer's confirmation).
    // Retrieval keeps its own timeouts; this only stops it eating the loop's.
    const deadlineAtMs = this.clock.nowMs() + this.config.agentLoopDeadlineMs;

    const images = understanding?.images ?? [];
    return this.runLoop(attachImages(assembled.messages, images), {
      tenantId: input.tenantId,
      toolContext: {
        tenantId: input.tenantId,
        // Nullish-coalesced to null rather than defaulted to anything: a
        // caller that has no conversation/customer (CommentReplyAgent) must
        // hand a customer-scoped tool an explicit "no identity", not a
        // placeholder one.
        conversationId: input.conversationId ?? null,
        customerId: input.customerId ?? null,
        turnId: input.turnId ?? null,
        // Customer-side words only, plus the rolling summary that stands in
        // for turns older than the recent window: lets create_order check the
        // delivery address is the customer's own, not the model's invention.
        customerText: [
          input.conversationSummary ?? '',
          ...input.recentMessages
            .filter((message) => message.role === 'user')
            .map((message) => message.content),
          currentMessage,
        ]
          .filter((text) => text.length > 0)
          .join('\n'),
      },
      currentMessage,
      tools,
      retrievedChunks: retrieval.chunks,
      confidenceThreshold: input.tenantPolicy.confidenceThreshold,
      modalityConfidence: understanding?.confidence ?? 1,
      // A11: the vision binding answers the turn only when there is actually
      // an image on it. Every text turn keeps running on the default chat
      // binding — Feature 17 must not move the whole product onto a second
      // vendor to gain image understanding on a minority of turns.
      provider: images.length > 0 ? this.visionProvider : this.llmProvider,
      promptVersion: assembled.promptVersion,
      deadlineAtMs,
      inFinalGrace: false,
      telemetry,
      startMs,
    });
  }

  private async runLoop(
    initialMessages: LlmMessage[],
    ctx: LoopContext,
  ): Promise<AgentTurnResult> {
    let messages = initialMessages;
    let toolRoundTrips = 0;
    let correctiveRetries = 0;
    // Serialized results of every tool call that actually executed this turn.
    // Evidence for D10 and A6 alongside the cited chunks — see
    // finaliseRespondPayload().
    let toolEvidence: string[] = [];

    for (;;) {
      if (this.clock.nowMs() >= ctx.deadlineAtMs) {
        return this.outOfTime(messages, ctx, toolEvidence);
      }

      let result: LlmToolResult;
      try {
        result = await this.callProviderWithRetry(
          { messages, tools: ctx.tools },
          ctx.telemetry,
          ctx.provider,
          ctx.deadlineAtMs,
        );
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;

        // A timeout that lands past the deadline is a deadline hit, not a
        // provider outage: same handling as finding the deadline passed at the
        // top of the loop (one final respond if a tool already acted).
        if (
          error.code === 'LLM_TIMEOUT' &&
          (error instanceof CallDeadlineExceeded ||
            this.clock.nowMs() >= ctx.deadlineAtMs)
        ) {
          return this.outOfTime(messages, ctx, toolEvidence);
        }

        // Malformed-tool-call retries are corrective (a new message,
        // shared budget with every other "give the model another chance"
        // case), never a blind identical re-request.
        if (
          error.code === 'LLM_MALFORMED_TOOL_CALL' &&
          correctiveRetries < MAX_CORRECTIVE_RETRIES
        ) {
          correctiveRetries++;
          messages = [
            ...messages,
            correctiveInstructionMessage(
              'Your previous tool call was malformed. Try again with valid, well-formed arguments.',
            ),
          ];
          continue;
        }

        // Past the budget, a malformed call is still not an outage: the model
        // gets one respond-only call (see respondOnlyRecovery).
        if (error.code === 'LLM_MALFORMED_TOOL_CALL') {
          return this.respondOnlyRecovery(
            messages,
            ctx,
            toolEvidence,
            `provider_error:${error.code}`,
          );
        }

        const policy = getRescuePolicy(error.code);
        return this.terminalEscalation(
          policy.escalationReason ?? 'LLM_ERROR',
          'error_forced',
          ctx.promptVersion,
          ctx.telemetry,
          ctx.startMs,
          `provider_error:${error.code}`,
        );
      }

      const respondCall = result.toolCalls.find(
        (call) => call.name === RESPOND_TOOL_NAME,
      );
      if (respondCall) {
        const outcome = await this.handleRespondCall(
          respondCall,
          result,
          ctx,
          correctiveRetries,
          toolEvidence,
        );
        if (outcome.type === 'result') return outcome.result;
        messages = [...messages, ...outcome.appendMessages];
        correctiveRetries = outcome.correctiveRetries;
        continue;
      }

      if (result.toolCalls.length > 0) {
        const outcome = await this.handleToolRoundTrip(
          result,
          ctx,
          toolRoundTrips,
          correctiveRetries,
        );
        if (outcome.type === 'result') return outcome.result;
        if (outcome.type === 'recover') {
          return this.respondOnlyRecovery(
            [...messages, ...outcome.appendMessages],
            ctx,
            toolEvidence,
            'malformed_tool_args',
          );
        }
        messages = [...messages, ...outcome.appendMessages];
        toolRoundTrips = outcome.toolRoundTrips;
        correctiveRetries = outcome.correctiveRetries;
        toolEvidence = [...toolEvidence, ...outcome.toolEvidence];
        continue;
      }

      // No tool calls at all. Before spending a corrective retry, check whether
      // the model wrote the terminal payload as TEXT — open models regularly
      // emit valid `respond` arguments into `content` when the serving host's
      // tool parser misses the call. Only a COMPLETE, schema-valid payload is
      // accepted (see respond-text-fallback.ts); anything less falls through to
      // the corrective path below, unchanged.
      const salvaged = parseRespondPayloadFromText(result.content);
      if (salvaged)
        return await this.finaliseRespondPayload(salvaged, ctx, toolEvidence);

      // The model didn't terminate via `respond` in any recognisable form.
      if (correctiveRetries >= MAX_CORRECTIVE_RETRIES) {
        return this.respondOnlyRecovery(
          [...messages, { role: 'assistant', content: result.content }],
          ctx,
          toolEvidence,
          'no_respond_call',
        );
      }
      correctiveRetries++;
      messages = [
        ...messages,
        { role: 'assistant', content: result.content },
        correctiveInstructionMessage(
          // Measured 2026-08-16: `no_respond_call` was the ONLY cause behind
          // every lost turn in a 161-case run, and two of the three were short
          // multi-turn follow-ups ("and when is the rest due?") where the model
          // answers conversationally in plain text instead of terminating via
          // the tool. A bare restatement of the rule did not recover them, so
          // this names the fields and repeats the answer it already produced.
          'You replied with plain text instead of ending your turn. Do not send a plain-text reply. ' +
            'Call the `respond` tool now with your answer, cited_chunk_ids for every chunk you used, ' +
            'confidence, and escalate. This applies to short follow-up messages in an ongoing ' +
            'conversation exactly as it does to a first message.',
        ),
      ];
    }
  }

  /**
   * The corrective budget is spent and the model has still not ended the turn
   * (no `respond` call, or tool calls that could not be executed). Cycle 3b:
   * these were all forced LLM_ERROR escalations, yet most were a model trying
   * to call a tool with a detail the customer had not given yet —
   * `track_order({})` with no order reference, `create_order({})` with no
   * address — where the right reply is simply to ask for it.
   *
   * So the model gets exactly ONE more call, offered ONLY the `respond` tool:
   * it can no longer reach for a tool, so it either answers (typically: asks
   * for the missing detail) or the turn escalates as before, with the same
   * detail. Bounded like finalRespondAfterDeadline(): one attempt, no retry,
   * inside the loop's deadline (past it, outOfTime() decides). The payload goes
   * through finaliseRespondPayload() like any other, so every guard applies.
   */
  private async respondOnlyRecovery(
    messages: LlmMessage[],
    ctx: LoopContext,
    toolEvidence: string[],
    detail: EscalationDetail,
  ): Promise<AgentTurnResult> {
    if (this.clock.nowMs() >= ctx.deadlineAtMs) {
      return this.outOfTime(messages, ctx, toolEvidence);
    }
    const giveUp = (): AgentTurnResult =>
      this.terminalEscalation(
        'LLM_ERROR',
        'error_forced',
        ctx.promptVersion,
        ctx.telemetry,
        ctx.startMs,
        detail,
      );

    let result: LlmToolResult;
    try {
      result = await this.callProviderOnce(
        {
          messages: [
            ...messages,
            correctiveInstructionMessage(RESPOND_ONLY_RECOVERY_INSTRUCTION),
          ],
          tools: [RESPOND_TOOL_DEFINITION],
        },
        ctx.telemetry,
        ctx.provider,
        ctx.deadlineAtMs,
      );
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      if (error instanceof CallDeadlineExceeded) {
        return this.outOfTime(messages, ctx, toolEvidence);
      }
      return giveUp();
    }

    const respondCall = result.toolCalls.find(
      (call) => call.name === RESPOND_TOOL_NAME,
    );
    if (respondCall) {
      // Retries passed as already spent: an invalid payload escalates.
      const outcome = await this.handleRespondCall(
        respondCall,
        result,
        ctx,
        MAX_CORRECTIVE_RETRIES,
        toolEvidence,
      );
      return outcome.type === 'result' ? outcome.result : giveUp();
    }
    if (result.toolCalls.length === 0) {
      const salvaged = parseRespondPayloadFromText(result.content);
      if (salvaged)
        return this.finaliseRespondPayload(salvaged, ctx, toolEvidence);
    }
    return giveUp();
  }

  /** The loop's deadline is reached: with a tool result in hand, one final `respond` (see finalRespondAfterDeadline); without one, a plain deadline escalation. */
  private outOfTime(
    messages: LlmMessage[],
    ctx: LoopContext,
    toolEvidence: string[],
  ): Promise<AgentTurnResult> | AgentTurnResult {
    if (toolEvidence.length > 0) {
      return this.finalRespondAfterDeadline(messages, ctx, toolEvidence);
    }
    return this.terminalEscalation(
      'LLM_ERROR',
      'error_forced',
      ctx.promptVersion,
      ctx.telemetry,
      ctx.startMs,
      'deadline_exceeded',
    );
  }

  private async callProviderWithRetry(
    request: LlmToolRequest,
    telemetry: AgentRunTelemetry,
    /** A11: the turn's binding, threaded from LoopContext — never read off `this`, since a vision turn and a text turn can be in flight concurrently on this singleton. */
    provider: LlmProvider,
    /** Wall-clock ms past which no call may still be running and no retry may start. */
    deadlineAtMs: number,
  ): Promise<LlmToolResult> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.callProviderOnce(
          request,
          telemetry,
          provider,
          deadlineAtMs,
        );
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        // Malformed-tool-call retries are corrective (a new message,
        // handled by the caller's shared budget), never a blind identical
        // re-request — re-sending the same request tends to reproduce the
        // same malformed output.
        if (error.code === 'LLM_MALFORMED_TOOL_CALL') throw error;

        const policy = getRescuePolicy(error.code);
        attempt++;
        if (!policy.retryable || attempt >= (policy.maxAttempts ?? 1))
          throw error;
        // Eval I2: a retry's backoff plus its own call must not START past the
        // deadline, or one slow call is followed by a second full provider
        // timeout that nothing bounds.
        const backoffMs = policy.backoffMs ?? 0;
        if (this.clock.nowMs() + backoffMs >= deadlineAtMs) throw error;
        await this.sleep.wait(backoffMs);
      }
    }
  }

  /**
   * One provider call with its telemetry — no retry. The building block of
   * callProviderWithRetry(), and used alone where a retry's backoff would
   * overrun a hard cap.
   *
   * Eval I2 (2026-09-29, turns of 37-64s against an 8s deadline): the deadline
   * used to be checked only BEFORE a call, so a call started at 7.9s ran its
   * full LLM_REQUEST_TIMEOUT_MS (10s) past it. The provider port has no abort
   * signal, so the call is raced against the time remaining: when it loses, the
   * turn stops waiting (the abandoned request still ends at its own provider
   * timeout, but nothing awaits it).
   */
  private async callProviderOnce(
    request: LlmToolRequest,
    telemetry: AgentRunTelemetry,
    provider: LlmProvider,
    deadlineAtMs: number,
  ): Promise<LlmToolResult> {
    const callStartMs = this.clock.nowMs();
    const remainingMs = deadlineAtMs - callStartMs;
    if (remainingMs <= 0) throw new CallDeadlineExceeded();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CallDeadlineExceeded()), remainingMs);
    });
    let result: LlmToolResult;
    try {
      result = await Promise.race([
        provider.completeWithTools(request),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    telemetry.addSpan('llmMs', this.clock.nowMs() - callStartMs);
    telemetry.addUsage(result.usage);
    return result;
  }

  /**
   * The deadline passed, but a tool already produced a result this turn — a
   * lookup the customer is waiting on, or a side effect (create_order WROTE an
   * order). Escalating with the generic hand-off line here left customers
   * uninformed of an order that existed (live L2 evals, 2026-09-29: ~15 turns,
   * three ~3-4s DeepSeek calls routinely exceed 8s), which invites a duplicate
   * order. So the loop gets exactly ONE more provider call, to `respond`.
   *
   * Why a bounded grace call rather than answering from the tool result
   * directly: create_order's `customerMessage` is a machine TOKEN, not prose
   * (create-order-executor.ts) — L0 turns it into the customer's own dialect.
   * Emitting wording from here would hard-code one language into the loop and
   * produce an answer no guardrail has seen. The grace call instead yields a
   * normal payload that goes through finaliseRespondPayload() — citations,
   * D10 with this turn's toolEvidence, A5, and the A6 grounding check — like
   * any other answer.
   *
   * Bounds: the call is only STARTED before `deadline + FINAL_RESPOND_GRACE_MS`;
   * it is a single attempt (a retry's backoff would overrun the cap); and it
   * is terminal — anything but a valid `respond` (another tool call, an
   * invalid payload, a provider error) escalates, and no tool it asks for is
   * executed. A failure here is `error_forced` with its own detail
   * (`deadline_exceeded_after_tool`) so these turns, where a human must tell
   * the customer what already happened, are findable. An escalation the
   * payload itself decides stays `agent_decision` (D13).
   */
  private async finalRespondAfterDeadline(
    messages: LlmMessage[],
    ctx: LoopContext,
    toolEvidence: string[],
  ): Promise<AgentTurnResult> {
    // An order create_order already wrote must reach the customer even when no
    // model call can still deliver it: the confirmation is built from the
    // created order row itself (see order-confirmation.ts), so a missed
    // deadline no longer turns "order written" into "customer told to wait for
    // a human". With no order this turn, the escalation below is unchanged.
    // Clarly 2.0 S2: a booking book_appointment wrote gets the same guarantee.
    const orderConfirmation =
      [
        buildOrderConfirmation(toolEvidence, ctx.currentMessage),
        buildBookingConfirmation(toolEvidence, ctx.currentMessage),
      ]
        .filter((part): part is string => part !== null)
        .join('\n\n') || null;
    const giveUp = (
      detail: EscalationDetail = 'deadline_exceeded_after_tool',
      reason: EscalationReason = 'LLM_ERROR',
    ): AgentTurnResult =>
      orderConfirmation !== null
        ? this.deterministicOrderConfirmation(orderConfirmation, ctx, detail)
        : this.terminalEscalation(
            reason,
            'error_forced',
            ctx.promptVersion,
            ctx.telemetry,
            ctx.startMs,
            detail,
          );

    const hardCapAtMs = ctx.deadlineAtMs + FINAL_RESPOND_GRACE_MS;
    if (this.clock.nowMs() >= hardCapAtMs) return giveUp();
    const graceCtx: LoopContext = {
      ...ctx,
      deadlineAtMs: hardCapAtMs,
      inFinalGrace: true,
    };

    let result: LlmToolResult;
    try {
      result = await this.callProviderOnce(
        {
          messages: [
            ...messages,
            correctiveInstructionMessage(
              'You are out of time for further tool calls. Call the `respond` tool now. ' +
                'Tell the customer what the tool results above show — if a result carries a ' +
                '`customerMessage`, follow it exactly — and do not call any other tool.',
            ),
          ],
          tools: ctx.tools,
        },
        ctx.telemetry,
        ctx.provider,
        hardCapAtMs,
      );
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return giveUp(
        `provider_error:${error.code}`,
        getRescuePolicy(error.code).escalationReason ?? 'LLM_ERROR',
      );
    }

    const respondCall = result.toolCalls.find(
      (call) => call.name === RESPOND_TOOL_NAME,
    );
    if (respondCall) {
      // Retries passed as already spent: an invalid payload escalates here
      // instead of asking for another call.
      const outcome = await this.handleRespondCall(
        respondCall,
        result,
        graceCtx,
        MAX_CORRECTIVE_RETRIES,
        toolEvidence,
      );
      if (outcome.type !== 'result') return giveUp();
      // A payload the loop itself rejected (invalid arguments) is a give-up
      // too; a verdict the payload or a guardrail reached (agent_decision) is
      // the model's or the guard's call and stands.
      return outcome.result.escalationSource === 'error_forced'
        ? giveUp(outcome.result.escalationDetail)
        : outcome.result;
    }
    if (result.toolCalls.length === 0) {
      const salvaged = parseRespondPayloadFromText(result.content);
      if (salvaged)
        return this.finaliseRespondPayload(salvaged, graceCtx, toolEvidence);
    }
    return giveUp();
  }

  /**
   * The turn's answer when a created order has to be confirmed without a
   * model call: the templated text from the order row, delivered as a normal
   * (non-escalated) answer. Logged, because the detail that would have named
   * the failed branch is not on the result of a turn that did not escalate.
   */
  private deterministicOrderConfirmation(
    answer: string,
    ctx: LoopContext,
    detail: EscalationDetail,
  ): AgentTurnResult {
    this.logger.warn(
      `order confirmation sent from the created order row: the final respond did not deliver (${detail})`,
      AgentRuntime.name,
    );
    // The confirmation carries no safety claim, but a customer who mentioned an
    // allergy or a health risk in the same message still needs a person.
    const safetyRisk = reportsSafetyRisk(ctx.currentMessage);
    return {
      answer,
      citedChunkIds: [],
      confidence: 1,
      escalate: safetyRisk,
      escalationReason: safetyRisk ? 'CUSTOMER_DISTRESS' : null,
      escalationSource: safetyRisk ? 'agent_decision' : null,
      isHallucination: false,
      promptVersion: ctx.promptVersion,
      telemetry: {
        inputTokens: ctx.telemetry.inputTokens,
        outputTokens: ctx.telemetry.outputTokens,
        latencyMs: this.clock.nowMs() - ctx.startMs,
        spans: ctx.telemetry.spans,
      },
    };
  }

  private async handleRespondCall(
    respondCall: LlmToolResult['toolCalls'][number],
    result: LlmToolResult,
    ctx: LoopContext,
    correctiveRetries: number,
    toolEvidence: string[],
  ): Promise<
    | { type: 'result'; result: AgentTurnResult }
    | {
        type: 'continue';
        appendMessages: LlmMessage[];
        correctiveRetries: number;
      }
  > {
    const parsed = parseRespondPayload(respondCall.input);

    if (!parsed.ok) {
      if (correctiveRetries >= MAX_CORRECTIVE_RETRIES) {
        return {
          type: 'result',
          result: this.terminalEscalation(
            'LLM_ERROR',
            'error_forced',
            ctx.promptVersion,
            ctx.telemetry,
            ctx.startMs,
            'invalid_respond_payload',
          ),
        };
      }
      // Every call id in the batch is answered, not only respond's — a
      // sibling call left unanswered is an HTTP 400 on the next request.
      return {
        type: 'continue',
        correctiveRetries: correctiveRetries + 1,
        appendMessages: answeredToolCallMessages(result, (call) =>
          call.id === respondCall.id
            ? `Invalid respond arguments: ${parsed.errors.join('; ')}. Call respond again with valid arguments.`
            : 'Not executed: this call was sent together with an invalid respond call.',
        ),
      };
    }

    return {
      type: 'result',
      result: await this.finaliseRespondPayload(
        parsed.payload,
        ctx,
        toolEvidence,
      ),
    };
  }

  /**
   * The single terminal path for a validated respond payload: citation
   * verification, D10's composite confidence, A5's escalation decision, and —
   * only for a turn that would otherwise be delivered as-is — A6's grounding
   * check. Shared by the native tool-call route and the text-fallback route, so
   * a payload salvaged from `content` is guarded exactly like one the provider
   * parsed — there is no second, laxer way to end a turn.
   */
  private async finaliseRespondPayload(
    rawPayload: RespondPayload,
    ctx: LoopContext,
    /** Outputs of the tool calls that executed this turn. Non-empty means the answer can rest on tool results, not only on cited chunks. */
    toolEvidence: string[],
  ): Promise<AgentTurnResult> {
    const guardrailStartMs = this.clock.nowMs();
    // Eval A1: with zero chunks retrieved and a tool executed, a cited handle
    // ("c1") refers to nothing - drop it rather than count it fabricated.
    // Untouched whenever chunks WERE retrieved, so the fabricated-citation rule
    // is intact there.
    const payload = dropUnresolvableCitations(
      rawPayload,
      ctx.retrievedChunks.length,
      toolEvidence.length > 0,
    );
    // The model cites SHORT HANDLES (c1, c2, ...), never raw chunk UUIDs — see
    // citationHandle(). Everything downstream of this point (the guardrail, the
    // telemetry, the returned result) speaks in real chunk ids again.
    const handles = ctx.retrievedChunks.map((_, index) =>
      citationHandle(index),
    );
    const citationResult = verifyCitations(payload.cited_chunk_ids, handles);
    const citedChunkIds = resolveHandles(
      payload.cited_chunk_ids,
      ctx.retrievedChunks,
    );
    const retrievalSupportScore = averageCitedScore(
      citedChunkIds,
      ctx.retrievedChunks,
    );
    const safetyRisk = reportsSafetyRisk(ctx.currentMessage);
    const decision = computeEscalationDecision(
      payload,
      citationResult,
      retrievalSupportScore,
      ctx.confidenceThreshold,
      undefined,
      // D10 extended for A11/A12: a half-heard voice note or a barely legible
      // photo caps the composite confidence, so a media turn clears exactly the
      // same tenant threshold a typed question does — no lower bar, and no
      // confident answer built on input we could not read.
      ctx.modalityConfidence,
      // F27/D12: the input-side distress net. Run on the customer's own message
      // — not the answer — because a complaint written in Arabic is answered in
      // Arabic, which the answer-side net cannot read.
      reportsCustomerGrievance(ctx.currentMessage),
      toolEvidence.length > 0,
      // Cycle 3: allergy / health-risk turns always hand off, whatever the
      // model set (catering-quotes#7 was missed in 2 of 5 runs).
      safetyRisk,
      // Cycle 3: a stated late-delivery complaint escalates even though
      // track_order answered it (commerce-complaint#6, missed 3 of 3).
      isLateDeliveryComplaint(
        ctx.currentMessage,
        toolEvidence,
        this.clock.nowMs(),
      ),
      // Cycle 3b: track_order found nothing and the model did not hand off
      // (commerce-tracking#14, missed 3 of 3).
      trackOrderFoundNothing(toolEvidence),
    );
    ctx.telemetry.addSpan('guardrailMs', this.clock.nowMs() - guardrailStartMs);

    const grounding = await this.checkGrounding(
      payload,
      citedChunkIds,
      ctx,
      decision.escalate,
      toolEvidence,
    );
    if (grounding) return grounding;

    return {
      // A safety turn the model did not hand off itself is answered with the
      // deterministic handoff line, not with the model's draft: a draft that
      // said "it is safe" is an assurance no one qualified has given.
      answer:
        safetyRisk && !payload.escalate
          ? safetyHandoffAnswer(ctx.currentMessage)
          : payload.answer,
      // F10: reported alongside the answer, so capture costs no extra round
      // trip. Whether a key is one the tenant actually asked for is decided
      // by the caller, which knows the configuration.
      // Collapsed to a map at this boundary: a later duplicate key is the
      // model correcting itself, and last-wins is the same rule the storage
      // layer applies.
      intake: payload.intake
        ? Object.fromEntries(
            payload.intake.map((item) => [item.key, item.value]),
          )
        : undefined,
      citedChunkIds,
      confidence: decision.compositeConfidence,
      escalate: decision.escalate,
      escalationReason: decision.escalationReason,
      escalationSource: decision.escalationSource,
      isHallucination: decision.isHallucination,
      promptVersion: ctx.promptVersion,
      telemetry: {
        inputTokens: ctx.telemetry.inputTokens,
        outputTokens: ctx.telemetry.outputTokens,
        latencyMs: this.clock.nowMs() - ctx.startMs,
        spans: ctx.telemetry.spans,
      },
    };
  }

  private async handleToolRoundTrip(
    result: LlmToolResult,
    ctx: LoopContext,
    toolRoundTrips: number,
    correctiveRetries: number,
  ): Promise<
    | { type: 'result'; result: AgentTurnResult }
    /** Nothing executed and the corrective budget is spent: the caller makes the one respond-only call. */
    | { type: 'recover'; appendMessages: LlmMessage[] }
    | {
        type: 'continue';
        appendMessages: LlmMessage[];
        toolRoundTrips: number;
        correctiveRetries: number;
        /** Outputs of the calls that executed in this round trip, in call order — kept even when a sibling call was malformed. */
        toolEvidence: string[];
      }
  > {
    if (toolRoundTrips >= MAX_TOOL_ROUND_TRIPS) {
      return {
        type: 'result',
        result: this.terminalEscalation(
          'TOOL_FAILURE',
          'error_forced',
          ctx.promptVersion,
          ctx.telemetry,
          ctx.startMs,
          'tool_round_trip_cap',
        ),
      };
    }

    const toolExecutionStartMs = this.clock.nowMs();
    const recordToolSpan = (): void =>
      ctx.telemetry.addSpan(
        'toolExecutionMs',
        this.clock.nowMs() - toolExecutionStartMs,
      );
    const scopeViolation = (): {
      type: 'result';
      result: AgentTurnResult;
    } => ({
      type: 'result',
      result: this.terminalEscalation(
        'TOOL_SCOPE_VIOLATION',
        'error_forced',
        ctx.promptVersion,
        ctx.telemetry,
        ctx.startMs,
        'tool_scope_violation',
      ),
    });

    // Phase 1: authorize (validate + scope-check) the WHOLE batch before any
    // of it executes, so a scope violation escalates before a side effect has
    // happened rather than after one (a create_order written, then refused).
    const authorizedArgs = new Map<string, Record<string, unknown>>();
    const malformedCalls = new Set<string>();
    for (const call of result.toolCalls) {
      try {
        authorizedArgs.set(
          call.id,
          await this.toolExecution.authorize(
            ctx.toolContext,
            call.name,
            call.input,
          ),
        );
      } catch (error) {
        if (error instanceof LLMMalformedToolCall) {
          malformedCalls.add(call.id);
          continue;
        }
        recordToolSpan();
        if (error instanceof ToolScopeViolation) return scopeViolation();
        throw error;
      }
    }

    // Phase 2: execute every call that passed. A malformed sibling no longer
    // throws away the results of the calls that did run — they are real
    // evidence, and possibly a real side effect the customer must hear about.
    const outputs = new Map<string, string>();
    for (const call of result.toolCalls) {
      const args = authorizedArgs.get(call.id);
      if (!args) continue;
      try {
        const output = await this.toolExecution.execute(
          ctx.toolContext,
          call.name,
          args,
        );
        outputs.set(call.id, JSON.stringify(output));
      } catch (error) {
        // An executor's own belt-and-braces argument check (create_order).
        if (error instanceof LLMMalformedToolCall) {
          malformedCalls.add(call.id);
          continue;
        }
        recordToolSpan();
        if (error instanceof ToolScopeViolation) return scopeViolation();
        throw error;
      }
    }
    recordToolSpan();

    // Every call id in the assistant message gets a `tool` message — the real
    // output, or the error for a malformed call — and only THEN the corrective
    // guidance. An unanswered id is an HTTP 400 from OpenAI-compatible
    // providers (DeepSeek, 2026-09-29), which used to crash the turn.
    const toolMessages = answeredToolCallMessages(
      result,
      (call) =>
        outputs.get(call.id) ??
        `Error: your call to "${call.name}" had invalid arguments and was not executed.`,
    );
    const malformedNames = result.toolCalls
      .filter((call) => malformedCalls.has(call.id))
      .map((call) => `"${call.name}"`);

    // A spent corrective budget ends the tool phase only when NOTHING
    // executed. When a call in the batch did run, the loop continues so the
    // model can report it; the round-trip cap and the deadline still bound
    // the turn. With nothing executed, the turn is not escalated outright
    // either (cycle 3b: track_order({}) twice on a message with no order
    // reference ended LLM_ERROR 3/3): the caller makes one respond-only call.
    if (
      malformedCalls.size > 0 &&
      correctiveRetries >= MAX_CORRECTIVE_RETRIES &&
      outputs.size === 0
    ) {
      return { type: 'recover', appendMessages: toolMessages };
    }

    // A batch in which nothing executed (every call rejected as malformed —
    // an empty create_order({}) before any lookup_product) spent no tool and
    // no side effect, so it does not use up a round trip: the corrective
    // budget already bounds it, and the model still needs its full trips for
    // the lookup and the real order (cycle 3: commerce-journey hit
    // tool_round_trip_cap twice this way).
    return {
      type: 'continue',
      toolRoundTrips: outputs.size > 0 ? toolRoundTrips + 1 : toolRoundTrips,
      correctiveRetries:
        malformedCalls.size > 0 ? correctiveRetries + 1 : correctiveRetries,
      toolEvidence: [...outputs.values()],
      appendMessages:
        malformedNames.length > 0
          ? [
              ...toolMessages,
              correctiveInstructionMessage(
                malformedToolCallInstruction(malformedNames),
              ),
            ]
          : toolMessages,
    };
  }

  /** D2: "replies 'let me get a human'" — the exact fallback answer every forced escalation returns; the actual reply-sending is the caller's (respond-path, not built) job. `telemetry`/`startMs` are always passed explicitly (never read off `this`) — see LoopContext's own comment on why. */
  /**
   * A6 (2026-08-17): the output-side grounding net. Returns a terminal
   * escalation when the cited passages do not actually cover the question, and
   * `null` — the overwhelmingly common case — when there is nothing to say.
   *
   * Runs ONLY on a turn that is about to be delivered as a normal answer with
   * at least one citation. Every skip below is deliberate:
   * - already escalating: a human is involved regardless, so the extra call
   *   would buy nothing and would let a verifier failure downgrade a real
   *   escalation's reason.
   * - no evidence at all (zero citations and no tool ran): D10's zero-citation
   *   override already owns that case, and a no-KB turn (a greeting) has no
   *   grounding to check. A zero-citation answer after a tool call IS checked,
   *   against the tool results alone: D10 waives its override on "a tool ran",
   *   which is not the same as "the tool supplied this answer" (a no-match
   *   lookup followed by an uncited policy answer), so this is its net.
   * - past the deadline: D6's bound is the bound. A guard may not be the thing
   *   that blows the turn's wall clock — except on the post-deadline final
   *   answer after a tool ran (see the gate below).
   *
   * Fail-open by construction: `verdict === null` (call failed, unparseable,
   * hedged) falls through to `null` here, leaving the turn exactly as the agent
   * produced it. See answer-grounding-verifier.service.ts property 1.
   */
  private async checkGrounding(
    payload: RespondPayload,
    citedChunkIds: string[],
    ctx: LoopContext,
    alreadyEscalating: boolean,
    toolEvidence: string[],
  ): Promise<AgentTurnResult | null> {
    if (!this.config.agentGroundingCheckEnabled) return null;
    if (alreadyEscalating) return null;
    if (citedChunkIds.length === 0 && toolEvidence.length === 0) return null;
    // The one exception is the post-deadline final answer
    // (finalRespondAfterDeadline): it exists because a tool already acted, so
    // it is exactly the answer that must not leave unchecked. The verifier is
    // a single bounded call that fails open, so this cannot hang the turn.
    if (!ctx.inFinalGrace && this.clock.nowMs() >= ctx.deadlineAtMs)
      return null;

    const citedPassages = citedChunkIds
      .map(
        (id) => ctx.retrievedChunks.find((chunk) => chunk.id === id)?.content,
      )
      .filter((content): content is string => Boolean(content));
    if (citedPassages.length === 0 && toolEvidence.length === 0) return null;
    // Retrieved-but-uncited chunks: knowledge-base text the agent saw, and the
    // other half of a multi-chunk answer (price in one chunk, EMI threshold in
    // another) when it cited only one. Offered ONLY beside at least one cited
    // passage, so an answer that cites nothing is still judged against the tool
    // results alone — D10 owns the zero-citation case.
    const citedIds = new Set(citedChunkIds);
    const otherRetrievedPassages =
      citedPassages.length > 0
        ? ctx.retrievedChunks
            .filter((chunk) => !citedIds.has(chunk.id))
            .map((chunk) => chunk.content)
            .filter((content) => Boolean(content))
        : [];

    const groundingStartMs = this.clock.nowMs();
    const { verdict, usage } = await this.groundingVerifier.check({
      question: ctx.currentMessage,
      answer: payload.answer,
      citedPassages,
      otherRetrievedPassages,
      // Every tool result of the turn (create_order, track_order, lookups),
      // labelled as such: mixed into the passages they read as a "passage"
      // that no policy document backs, and a correct order or tracking answer
      // came back NOT_COVERED (cycle 3: commerce-tracking#2/#18).
      toolResultPassages: toolEvidence,
    });
    ctx.telemetry.addSpan('groundingMs', this.clock.nowMs() - groundingStartMs);
    // A8: the check's tokens are the turn's tokens. Counted even when the
    // verdict is null — spend that happened is spend that gets reported.
    ctx.telemetry.addUsage(usage);

    if (verdict === 'NOT_COVERED' || verdict === 'CONFLICT') {
      this.logGroundingOverride(payload, verdict, ctx, {
        cited: citedPassages.length,
        otherRetrieved: otherRetrievedPassages.length,
        toolResults: toolEvidence.length,
      });
    }
    if (verdict === 'NOT_COVERED') {
      return this.terminalEscalation(
        'KB_NOT_INDEXED',
        'agent_decision',
        ctx.promptVersion,
        ctx.telemetry,
        ctx.startMs,
        'grounding_not_covered',
      );
    }
    if (verdict === 'CONFLICT') {
      return this.terminalEscalation(
        'KB_CONFLICT',
        'agent_decision',
        ctx.promptVersion,
        ctx.telemetry,
        ctx.startMs,
        'grounding_conflict',
      );
    }
    return null;
  }

  /**
   * The override replaces the draft with a handoff line, so without this the
   * answer the verifier rejected is gone and a false override cannot be told
   * from a correct catch (cycle 3 had 14 L1 + ~20 L2 of them and no evidence).
   * Truncated: the draft is customer-facing text and may quote personal data.
   */
  private logGroundingOverride(
    payload: RespondPayload,
    verdict: 'NOT_COVERED' | 'CONFLICT',
    ctx: LoopContext,
    sources: { cited: number; otherRetrieved: number; toolResults: number },
  ): void {
    this.logger.warn(
      `grounding verifier overrode the draft answer (verdict=${verdict}, promptVersion=${ctx.promptVersion}, citedPassages=${sources.cited}, uncitedPassages=${sources.otherRetrieved}, toolResults=${sources.toolResults}); draft: ${JSON.stringify(
        payload.answer.slice(0, GROUNDING_DRAFT_LOG_CHARS),
      )}`,
      AgentRuntime.name,
    );
  }

  private terminalEscalation(
    reason: EscalationReason,
    source: EscalationSource,
    promptVersion: string,
    telemetry: AgentRunTelemetry,
    startMs: number,
    /** A8: WHICH branch of the loop gave up. `escalationReason` alone cannot say — five different failures all surface as LLM_ERROR, so a lost turn was previously unattributable and the retry policy could not be tuned on evidence. Diagnostic only; never shown to a customer. */
    detail: EscalationDetail,
  ): AgentTurnResult {
    return {
      escalationDetail: detail,
      answer:
        "I'm going to connect you with a human agent who can help with this.",
      citedChunkIds: [],
      confidence: 0,
      escalate: true,
      escalationReason: reason,
      escalationSource: source,
      isHallucination: false,
      promptVersion,
      telemetry: {
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        latencyMs: this.clock.nowMs() - startMs,
        spans: telemetry.spans,
      },
    };
  }
}

/**
 * The identifier the model is asked to cite: a short, positional handle over the
 * chunks retrieved for THIS turn, not the chunk's UUID.
 *
 * Measured 2026-08-16: asking for 36-character UUIDs produced two "hallucinated"
 * citations in a single 161-case run that were nothing of the kind — the model
 * dropped one hyphen-separated segment while copying (`...41cd-8ef5...` for
 * `...41cd-879a-8ef5...`). The D10 guardrail then correctly forced confidence to
 * 0, escalated a correct answer, and logged a hallucination event. Transcription
 * length is not a signal about truthfulness, and hallucination is the one metric
 * that must not carry noise, so the copying task is made trivial instead.
 *
 * Handles are per-turn and positional; nothing persists them, and the real chunk
 * ids are restored before the result leaves the loop.
 */
function citationHandle(index: number): string {
  return `c${index + 1}`;
}

/**
 * A11/A12: the single text the whole turn is run on.
 *
 * The customer's own words come first — a caption is the readable half of a
 * photo message and must not be buried under a machine description. The derived
 * blocks are already `<untrusted_*>`-delimited by the media stage, matching L4/
 * L6's treatment of KB content and user messages: a transcript and a picture's
 * text are data, never instructions.
 *
 * A media turn with no caption at all still gets a non-empty message, so
 * retrieval and the prompt never receive '' and quietly answer nothing.
 */
export function composeCurrentMessage(
  typedMessage: string,
  understanding: MediaUnderstanding | null,
): string {
  if (!understanding || !understanding.derivedText) return typedMessage;
  const typed = typedMessage.trim();
  return typed
    ? `${typed}\n\n${understanding.derivedText}`
    : understanding.derivedText;
}

/**
 * A11: puts the image bytes on the LAST user message — the one L6 just built
 * out of this turn's message. The prompt layers stay text-only and
 * modality-unaware (D11): PromptModule renders words, and the attachment rides
 * alongside them rather than being rendered into them.
 */
function attachImages(
  messages: LlmMessage[],
  images: LlmImageAttachment[],
): LlmMessage[] {
  if (images.length === 0) return messages;
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex === -1) return messages;
  return messages.map((message, index) =>
    index === lastUserIndex && message.role === 'user'
      ? { ...message, attachments: images }
      : message,
  );
}

/** Maps the model's handles back to real chunk ids. An unknown handle maps to nothing — verifyCitations() has already flagged it as fabricated. */
function resolveHandles(
  citedHandles: string[],
  retrievedChunks: RetrievedChunkResult[],
): string[] {
  return citedHandles
    .map((handle) => {
      const index = Number(handle.replace(/^c/i, '')) - 1;
      return retrievedChunks[index]?.id;
    })
    .filter((id): id is string => id !== undefined);
}

/** D10's retrieval_support_score, scoped to what the model actually cited — not "the best chunk retrieved overall," which could overstate support for an answer that cited something else. Citations that don't match a retrieved chunk contribute 0 (defensive; verifyCitations()'s hard override already zeroes confidence for that case before this value would matter). */
function averageCitedScore(
  citedChunkIds: string[],
  retrievedChunks: RetrievedChunkResult[],
): number {
  if (citedChunkIds.length === 0) return 0;
  const scoreById = new Map(
    retrievedChunks.map((chunk) => [chunk.id, chunk.score]),
  );
  const scores = citedChunkIds.map((id) => scoreById.get(id) ?? 0);
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/** What the model is told when the corrective budget is spent; see AgentRuntime.respondOnlyRecovery(). */
const RESPOND_ONLY_RECOVERY_INSTRUCTION =
  'You cannot call any more tools this turn. Call the `respond` tool now. ' +
  'If a tool needed a detail the customer has not given you yet — an order reference or tracking number, ' +
  'their name, phone number or delivery address, or which product they mean — ask them for exactly that detail. ' +
  'Otherwise answer from what the conversation and any tool results above already show, or escalate.';

/**
 * The corrective nudge after a rejected tool call. It used to say only "try
 * again with valid arguments", which a model missing a detail the customer
 * never gave cannot do — it re-sent the same empty call until the budget ran
 * out (cycle 3b: track_order({}) and create_order({}), both ending LLM_ERROR).
 * Deliberately names no validation detail: the rejection itself stays opaque
 * (see ToolExecutionService's header on why), this only names the way out.
 */
export function malformedToolCallInstruction(toolNames: string[]): string {
  return (
    `Your call to ${toolNames.join(', ')} had invalid or missing arguments and was not executed. ` +
    'Do not send it again with the same arguments. If it needs a detail the customer has not given you yet ' +
    '(an order reference or tracking number, their name, phone number or delivery address, or which product), ' +
    'call `respond` and ask the customer for exactly what is missing. Otherwise call it again with complete, valid arguments.'
  );
}
