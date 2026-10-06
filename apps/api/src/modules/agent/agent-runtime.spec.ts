import {
  KBNotIndexed,
  LLMEmptyResponse,
  LLMMalformedToolCall,
  LLMRefusal,
  LLMTimeout,
  ToolScopeViolation,
} from '@repo/errors';
import type { Clock } from '../core/clock/clock';
import type { Sleep } from '../core/sleep/sleep';
import type { AppConfigService } from '../core/config/app-config.service';
import type { AppLoggerService } from '../core/logger/app-logger.service';
import type { ConversationService } from '../conversation/conversation.service';
import type { AnswerGroundingVerifierService } from '../guardrail/answer-grounding-verifier.service';
import type { GroundingVerdict } from '../guardrail/answer-grounding';
import type { ForbiddenTopicCheckerService } from '../guardrail/forbidden-topic-checker.service';
import type {
  LlmProvider,
  LlmToolResult,
  VisionLlmProvider,
} from '../llm/ports/llm-provider.port';
import type { MediaUnderstandingService } from './media/media-understanding.service';
import type { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import type {
  RetrievalSearchResult,
  RetrievalSearchService,
} from '../retrieval/retrieval-search.service';
import type { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import type { ToolExecutionService } from '../tool-execution/tool-execution.service';
import { AgentRuntime } from './agent-runtime';
import { FINAL_RESPOND_GRACE_MS } from './agent-loop-config';
import { RESPOND_TOOL_NAME } from './respond-tool-definition';
import type { AgentTurnInput } from './agent-turn.dto';

const TENANT_A = 'tenant-a';
/** F25 D6.1 / F26 D4: the turn identity a tool call is authorized and executed under. */
const CONVERSATION_A = 'conversation-a';
const CUSTOMER_A = 'customer-a';
const TURN_A = 'coalesce-tenant-a-window-1';

// The model is shown positional citation handles (c1, c2 - see citationHandle()
// in agent-runtime.ts), never these UUID-shaped ids. Payload fixtures below cite
// handles; assertions on the RESULT expect the real chunk ids back.
const RETRIEVAL_RESULT: RetrievalSearchResult = {
  chunks: [
    { id: 'chunk-1', content: 'Refunds take 5 days.', score: 0.9 },
    { id: 'chunk-2', content: 'Shipping takes 3-5 days.', score: 0.8 },
  ],
  queryEmbedding: [0.1, 0.2],
  // P0.3: the phase breakdown the runtime copies into agent_runs.spans. Real
  // numbers rather than zeros so the sub-span plumbing is actually asserted —
  // zeros are indistinguishable from "never recorded" by design.
  timings: {
    embedMs: 300,
    embedHttpTtfbMs: 280,
    embedHttpBodyMs: 15,
    vectorQueryMs: 6,
    lexicalQueryMs: 2,
    fusionMs: 1,
    storeMs: 12,
    rerankMs: 0,
    totalMs: 312,
  },
};

function respondResult(payload: Record<string, unknown>): LlmToolResult {
  return {
    content: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [
      { id: 'call-respond', name: RESPOND_TOOL_NAME, input: payload },
    ],
  };
}

function toolCallResult(
  name: string,
  input: Record<string, unknown>,
): LlmToolResult {
  return {
    content: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [{ id: `call-${name}`, name, input }],
  };
}

function plainTextResult(content: string): LlmToolResult {
  return {
    content,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [],
  };
}

function makeConfig(
  deadlineMs = 8000,
  agentGroundingCheckEnabled = true,
): AppConfigService {
  return {
    agentLoopDeadlineMs: deadlineMs,
    agentGroundingCheckEnabled,
  } as unknown as AppConfigService;
}

/** A6's grounding net. Defaults to "no opinion", which is what the overwhelming majority of turns get and what every pre-existing test in this file assumes. */
function makeGroundingVerifier(verdict: GroundingVerdict | null = null): {
  verifier: AnswerGroundingVerifierService;
  check: jest.Mock;
} {
  const check = jest.fn().mockResolvedValue({
    verdict,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return {
    verifier: { check } as unknown as AnswerGroundingVerifierService,
    check,
  };
}

function makeClock(nowValues: number[]): Clock {
  let call = 0;
  const nowMs = jest.fn(
    () => nowValues[Math.min(call++, nowValues.length - 1)] ?? 0,
  );
  return { now: () => new Date(nowMs()), nowMs };
}

function makeSleep(): { sleep: Sleep; wait: jest.Mock } {
  const wait = jest.fn().mockResolvedValue(undefined);
  return { sleep: { wait }, wait };
}

function makeRetrievalSearch(
  impl: (
    tenantId: string,
    text: string,
    rerank: boolean,
  ) => Promise<RetrievalSearchResult>,
): RetrievalSearchService {
  return { search: jest.fn(impl) } as unknown as RetrievalSearchService;
}

function makeForbiddenTopicChecker(
  isForbidden = false,
): ForbiddenTopicCheckerService {
  return {
    check: jest.fn().mockResolvedValue({ isForbidden }),
  } as unknown as ForbiddenTopicCheckerService;
}

const ECHO_TOOL_SCHEMA = {
  name: 'echo',
  description: 'echoes',
  parameters: { type: 'object' },
};

function makeToolRegistry(
  toolSchemas: unknown[] = [ECHO_TOOL_SCHEMA],
): TenantToolRegistryService {
  return {
    getPromptToolSchemas: jest.fn().mockResolvedValue(toolSchemas),
  } as unknown as TenantToolRegistryService;
}

function makeToolExecution(overrides: Partial<ToolExecutionService> = {}): {
  toolExecution: ToolExecutionService;
  authorize: jest.Mock;
  execute: jest.Mock;
} {
  const authorize = jest.fn().mockResolvedValue({ message: 'hi' });
  const execute = jest.fn().mockResolvedValue({ message: 'hi' });
  return {
    toolExecution: {
      authorize,
      execute,
      ...overrides,
    } as unknown as ToolExecutionService,
    authorize,
    execute,
  };
}

function makePromptAssembly(): PromptAssemblyService {
  return {
    assemble: jest.fn().mockReturnValue({
      messages: [
        { role: 'system', content: 'L0' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          name: 'echo',
          description: 'echoes',
          inputSchema: { type: 'object' },
        },
      ],
      promptVersion: 'v1',
    }),
  };
}

function makeInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    tenantId: TENANT_A,
    conversationSummary: null,
    recentMessages: [],
    currentMessage: 'When do refunds arrive?',
    tenantPolicy: {
      tonePersonaOverride: null,
      forbiddenTopics: [],
      confidenceThreshold: 0.5,
      rerankEnabled: false,
    },
    ...overrides,
  };
}

/** F17/A11: the vision binding is irrelevant to every text-turn test here — a text turn never touches it. The media-modality tests live in agent-runtime-media.spec.ts. */
function makeVisionProvider(): VisionLlmProvider {
  return {
    complete: jest.fn(),
    completeWithTools: jest.fn(),
    countTokens: jest.fn(),
    supportsVision: () => true,
  };
}

function makeMediaUnderstanding(): MediaUnderstandingService {
  return {
    understand: jest.fn(),
  } as unknown as MediaUnderstandingService;
}

function makeConversations(): ConversationService {
  return {
    saveMediaTranscripts: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationService;
}

function makeLogger(): AppLoggerService {
  return { warn: jest.fn(), error: jest.fn() } as unknown as AppLoggerService;
}

interface Harness {
  runtime: AgentRuntime;
  llmProvider: LlmProvider;
  completeWithTools: jest.Mock;
  toolExecution: ToolExecutionService;
  wait: jest.Mock;
  clock: Clock;
  groundingCheck: jest.Mock;
  logger: { warn: jest.Mock; error: jest.Mock };
  assemble: jest.Mock;
  forbiddenCheck: jest.Mock;
}

function makeRuntime(opts: {
  completeWithTools: jest.Mock;
  retrievalSearch?: RetrievalSearchService;
  forbiddenTopicChecker?: ForbiddenTopicCheckerService;
  toolExecution?: ToolExecutionService;
  clockValues?: number[];
  deadlineMs?: number;
  groundingVerdict?: GroundingVerdict | null;
  groundingCheckEnabled?: boolean;
  /** The tenant's ENABLED tools. Defaults to one (`echo`), like most tenants with a synced catalog. */
  toolSchemas?: unknown[];
  /** Overrides `clockValues` — for tests where a mock (a slow tool, a slow provider call) advances time itself. */
  clock?: Clock;
}): Harness {
  const llmProvider = {
    completeWithTools: opts.completeWithTools,
  } as unknown as LlmProvider;
  const toolExecution = opts.toolExecution ?? makeToolExecution().toolExecution;
  const { sleep, wait } = makeSleep();
  const clock =
    opts.clock ?? makeClock(opts.clockValues ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const grounding = makeGroundingVerifier(opts.groundingVerdict ?? null);
  const promptAssembly = makePromptAssembly();
  const logger = { warn: jest.fn(), error: jest.fn() };
  const forbiddenTopicChecker =
    opts.forbiddenTopicChecker ?? makeForbiddenTopicChecker();

  const runtime = new AgentRuntime(
    promptAssembly,
    llmProvider,
    makeVisionProvider(),
    makeMediaUnderstanding(),
    opts.retrievalSearch ??
      makeRetrievalSearch(() => Promise.resolve(RETRIEVAL_RESULT)),
    forbiddenTopicChecker,
    grounding.verifier,
    makeToolRegistry(opts.toolSchemas),
    toolExecution,
    makeConversations(),
    makeConfig(opts.deadlineMs, opts.groundingCheckEnabled),
    clock,
    sleep,
    logger as unknown as AppLoggerService,
  );

  return {
    runtime,
    llmProvider,
    completeWithTools: opts.completeWithTools,
    toolExecution,
    wait,
    clock,
    groundingCheck: grounding.check,
    logger,
    // eslint-disable-next-line @typescript-eslint/unbound-method
    assemble: promptAssembly.assemble as jest.Mock,
    // eslint-disable-next-line @typescript-eslint/unbound-method
    forbiddenCheck: forbiddenTopicChecker.check as jest.Mock,
  };
}

describe('AgentRuntime.respond() — citation handles', () => {
  it('shows the model short positional handles, not chunk UUIDs', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const promptAssembly = makePromptAssembly();
    const runtime = new AgentRuntime(
      promptAssembly,
      { completeWithTools } as unknown as LlmProvider,
      makeVisionProvider(),
      makeMediaUnderstanding(),
      makeRetrievalSearch(() => Promise.resolve(RETRIEVAL_RESULT)),
      makeForbiddenTopicChecker(),
      makeGroundingVerifier().verifier,
      makeToolRegistry(),
      makeToolExecution().toolExecution,
      makeConversations(),
      makeConfig(),
      makeClock([0]),
      makeSleep().sleep,
      makeLogger(),
    );

    await runtime.respond(makeInput());

    const assembleCalls = (promptAssembly.assemble as jest.Mock).mock
      .calls as Array<[{ retrievedChunks: Array<{ id: string }> }]>;
    const assembleArgs = assembleCalls[0][0];
    expect(assembleArgs.retrievedChunks.map((chunk) => chunk.id)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('resolves cited handles back to real chunk ids in the result', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c2', 'c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.citedChunkIds).toEqual(['chunk-2', 'chunk-1']);
    expect(result.escalate).toBe(false);
  });

  it('treats an unknown handle as a fabricated citation', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c9'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.isHallucination).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.citedChunkIds).toEqual([]);
  });
});

describe('AgentRuntime.respond() — happy path', () => {
  it('returns the model answer with no escalation when confidence is above threshold and citations are valid', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Refunds take 5 days.',
        cited_chunk_ids: ['c1'],
        confidence: 0.95,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result).toEqual({
      answer: 'Refunds take 5 days.',
      citedChunkIds: ['chunk-1'],
      // B1: the model self-report, not min()'d against the 0.9 retrieval score.
      confidence: 0.95,
      escalate: false,
      escalationReason: null,
      escalationSource: null,
      isHallucination: false,
      promptVersion: 'v1',
      // A8: the fake Clock in this suite returns a constant 0 from every
      // nowMs() call (see makeClock() above), so every span the RUNTIME
      // times itself computes to exactly 0 duration and is dropped (the
      // telemetry accumulator only records a span once it observes >0ms, to
      // distinguish "this stage never ran" from "it ran instantly," which
      // a real Clock never actually produces for two sequential calls).
      // Token usage still accumulates correctly regardless of timing.
      //
      // P0.3: the retrieval sub-spans are the exception, and deliberately so
      // — they are measured inside RetrievalSearchService and merely copied
      // here, so they survive a frozen runtime clock. `retrievalRerankMs` is
      // absent because the fixture has rerank off (0ms → dropped).
      telemetry: {
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 0,
        spans: {
          retrievalEmbedMs: 300,
          retrievalEmbedHttpTtfbMs: 280,
          retrievalVectorQueryMs: 6,
          retrievalLexicalQueryMs: 2,
          retrievalFusionMs: 1,
        },
      },
    });
  });

  it('accumulates real, non-zero span durations and total latency when the clock actually advances', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Refunds take 5 days.',
        cited_chunk_ids: ['c1'],
        confidence: 0.95,
        escalate: false,
      }),
    );
    // Every nowMs() call this turn makes advances by 10ms — enough calls
    // supplied that makeClock() never has to clamp to the last value
    // (which would silently make later spans compute as 0 again).
    const clockValues = Array.from({ length: 30 }, (_, i) => i * 10);
    const { runtime } = makeRuntime({ completeWithTools, clockValues });

    const result = await runtime.respond(makeInput());

    expect(result.telemetry.latencyMs).toBeGreaterThan(0);
    expect(result.telemetry.spans.retrievalMs).toBeGreaterThan(0);
    expect(result.telemetry.spans.guardrailMs).toBeGreaterThan(0);
    expect(result.telemetry.spans.llmMs).toBeGreaterThan(0);
    expect(result.telemetry.inputTokens).toBe(10);
    expect(result.telemetry.outputTokens).toBe(5);
  });
});

describe('AgentRuntime.respond() — D12 pre-LLM checks', () => {
  it('escalates KB_NOT_INDEXED and never calls the LLM when the tenant has no indexed KB and no enabled tools', async () => {
    const completeWithTools = jest.fn();
    const searchSpy = jest.fn(() => Promise.reject(new KBNotIndexed()));
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(searchSpy),
      toolSchemas: [],
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('KB_NOT_INDEXED');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('kb_not_indexed');
    expect(completeWithTools).not.toHaveBeenCalled();
    // Nothing else could answer this turn, so an empty index stays fatal.
    expect(searchSpy).toHaveBeenCalledWith(
      TENANT_A,
      expect.any(String),
      false,
      undefined,
      { allowEmpty: false },
    );
  });

  it('escalates FORBIDDEN_TOPIC and never calls the LLM when the intake check matches', async () => {
    const completeWithTools = jest.fn();
    const { runtime } = makeRuntime({
      completeWithTools,
      forbiddenTopicChecker: makeForbiddenTopicChecker(true),
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('FORBIDDEN_TOPIC');
    expect(result.escalationSource).toBe('agent_decision');
    expect(completeWithTools).not.toHaveBeenCalled();
  });
});

const EMPTY_RETRIEVAL: RetrievalSearchResult = {
  ...RETRIEVAL_RESULT,
  chunks: [],
};

// L2 (2026-09-28): a merchant with a synced catalog and an empty KB used to get
// "connecting you to a human" on every message, because retrieval's empty-index
// signal escalated before the loop — lookup_product/create_order/track_order
// were unreachable. With at least one enabled tool the turn now runs with no KB
// context; the tools are the evidence.
describe('AgentRuntime.respond() — empty KB with enabled tools', () => {
  it('asks retrieval for an empty result instead of an error when the tenant has tools', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'hello',
        cited_chunk_ids: [],
        confidence: 0.9,
        escalate: false,
        no_kb_needed: true,
      }),
    );
    const searchSpy = jest.fn(() => Promise.resolve(EMPTY_RETRIEVAL));
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(searchSpy),
    });

    await runtime.respond(makeInput());

    expect(searchSpy).toHaveBeenCalledWith(
      TENANT_A,
      expect.any(String),
      false,
      undefined,
      { allowEmpty: true },
    );
  });

  it('runs the agent loop with zero KB chunks and still applies the forbidden-topic check', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'The Orbit V3 is in stock.',
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime, assemble, forbiddenCheck } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(() =>
        Promise.resolve(EMPTY_RETRIEVAL),
      ),
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(2);
    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({ retrievedChunks: [] }),
    );
    // D12 still runs, on retrieval's embedding — no second embed call.
    expect(forbiddenCheck).toHaveBeenCalledWith(
      EMPTY_RETRIEVAL.queryEmbedding,
      [],
    );
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('The Orbit V3 is in stock.');
    expect(result.confidence).toBe(0.9);
  });

  // Eval A1 (2026-09-29, commerce-lookup 75/75): the model cites "c1" although
  // zero chunks were retrieved. That handle refers to nothing, so it must be
  // dropped, not counted as a fabricated citation.
  it('a tool-grounded answer that cites a handle when NO chunk was retrieved is not a hallucination and is not escalated', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'The Orbit V3 is 899 AED.',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(() =>
        Promise.resolve(EMPTY_RETRIEVAL),
      ),
    });

    const result = await runtime.respond(makeInput());

    expect(result.isHallucination).toBe(false);
    expect(result.escalate).toBe(false);
    expect(result.confidence).toBe(0.9);
    expect(result.citedChunkIds).toEqual([]);
  });

  it('still flags a fabricated handle as a hallucination when no chunk was retrieved AND no tool ran', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Made up.',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(() =>
        Promise.resolve(EMPTY_RETRIEVAL),
      ),
    });

    const result = await runtime.respond(makeInput());

    expect(result.isHallucination).toBe(true);
    expect(result.escalate).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('still escalates FORBIDDEN_TOPIC on an empty-KB turn', async () => {
    const completeWithTools = jest.fn();
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(() =>
        Promise.resolve(EMPTY_RETRIEVAL),
      ),
      forbiddenTopicChecker: makeForbiddenTopicChecker(true),
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('FORBIDDEN_TOPIC');
    expect(completeWithTools).not.toHaveBeenCalled();
  });

  it('escalates a KB-shaped answer with no tool call and no citations, exactly as before', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Refunds take 5 days.',
        cited_chunk_ids: [],
        confidence: 0.95,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(() =>
        Promise.resolve(EMPTY_RETRIEVAL),
      ),
    });

    const result = await runtime.respond(makeInput());

    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });
});

describe('AgentRuntime.respond() — provider error handling (T1 exception classes)', () => {
  it('retries LLMTimeout with backoff, then succeeds', async () => {
    const completeWithTools = jest
      .fn()
      .mockRejectedValueOnce(new LLMTimeout())
      .mockResolvedValueOnce(
        respondResult({
          answer: 'ok',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime, wait } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(false);
    expect(wait).toHaveBeenCalledWith(500);
  });

  it('escalates LLM_ERROR (error_forced) once LLMTimeout retries are exhausted', async () => {
    const completeWithTools = jest.fn().mockRejectedValue(new LLMTimeout());
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(completeWithTools).toHaveBeenCalledTimes(2); // RESCUE_POLICY.LLM_TIMEOUT.maxAttempts
  });

  it('retries LLMEmptyResponse once (maxAttempts 1), then escalates if it keeps failing', async () => {
    const completeWithTools = jest
      .fn()
      .mockRejectedValue(new LLMEmptyResponse());
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(completeWithTools).toHaveBeenCalledTimes(1);
  });

  it('does not retry LLMRefusal (not retryable) — escalates immediately', async () => {
    const completeWithTools = jest.fn().mockRejectedValue(new LLMRefusal());
    const { runtime, wait } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('LLMMalformedToolCall from the provider consumes the corrective-retry budget, not a blind identical retry', async () => {
    const completeWithTools = jest
      .fn()
      .mockRejectedValueOnce(new LLMMalformedToolCall())
      .mockResolvedValueOnce(
        respondResult({
          answer: 'ok',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(false);
    expect(completeWithTools).toHaveBeenCalledTimes(2);
    // Second call's messages should include a corrective instruction.
    const calls = completeWithTools.mock.calls as unknown as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    const secondCallArgs = calls[1]?.[0];
    expect(
      secondCallArgs?.messages.some((m) => m.content.includes('malformed')),
    ).toBe(true);
  });

  it('escalates LLM_ERROR when LLMMalformedToolCall persists past the corrective-retry budget', async () => {
    const completeWithTools = jest
      .fn()
      .mockRejectedValue(new LLMMalformedToolCall());
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationDetail).toBe(
      'provider_error:LLM_MALFORMED_TOOL_CALL',
    );
    // initial + MAX_CORRECTIVE_RETRIES (2 since 2026-08-16, see
    // agent-loop-config.ts) + the one respond-only recovery call (cycle 3b).
    expect(completeWithTools).toHaveBeenCalledTimes(4);
  });
});

describe('AgentRuntime.respond() — bounded tool round-trips', () => {
  it('executes a tool call, feeds the result back, and terminates via respond within the round-trip budget', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution, authorize, execute } = makeToolExecution();
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(result.answer).toBe('done');
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A }),
      'echo',
      { message: 'hi' },
    );
    // F20/F24 wiring: execute() takes the tenant explicitly, and it must be
    // the same tenant authorize() was checked against — the real tools below
    // it (lookup_product, create_order) read that tenant's own rows.
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A }),
      'echo',
      { message: 'hi' },
    );
  });

  // --- F25 D6.1 / F26 D4: ToolExecutionContext threading ---

  it('builds the tool context from the turn and passes the SAME object to authorize() and execute()', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution, authorize, execute } = makeToolExecution();
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    await runtime.respond(
      makeInput({
        conversationId: CONVERSATION_A,
        customerId: CUSTOMER_A,
        turnId: TURN_A,
      }),
    );

    const expectedCtx = {
      tenantId: TENANT_A,
      conversationId: CONVERSATION_A,
      customerId: CUSTOMER_A,
      turnId: TURN_A,
      customerText: 'When do refunds arrive?',
    };
    expect(authorize).toHaveBeenCalledWith(expectedCtx, 'echo', {
      message: 'hi',
    });
    expect(execute).toHaveBeenCalledWith(expectedCtx, 'echo', {
      message: 'hi',
    });
    // Not merely equal — identical. An authorization decision made for one
    // turn must not be spendable on another, which is only guaranteed if
    // both calls see the one object the loop built.
    const authorizeCalls = authorize.mock.calls as unknown as Array<[unknown]>;
    const executeCalls = execute.mock.calls as unknown as Array<[unknown]>;
    expect(executeCalls[0][0]).toBe(authorizeCalls[0][0]);
  });

  it('passes explicit nulls for a turn with no conversation, customer or turn id (the CommentReplyAgent caller)', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution, authorize, execute } = makeToolExecution();
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    // makeInput() carries no conversation/customer/turn — exactly the shape
    // CommentReplyAgent sends. A placeholder id here would be an identity a
    // customer-scoped tool could read; null is what makes it fail closed.
    await runtime.respond(makeInput());

    const expectedCtx = {
      tenantId: TENANT_A,
      conversationId: null,
      customerId: null,
      turnId: null,
      customerText: 'When do refunds arrive?',
    };
    expect(authorize).toHaveBeenCalledWith(expectedCtx, 'echo', {
      message: 'hi',
    });
    expect(execute).toHaveBeenCalledWith(expectedCtx, 'echo', {
      message: 'hi',
    });
  });

  it('escalates TOOL_FAILURE once the tool round-trip budget (3) is exhausted without a terminal respond call', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(toolCallResult('echo', { message: 'hi' }));
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('TOOL_FAILURE');
    expect(result.escalationSource).toBe('error_forced');
    // MAX_TOOL_ROUND_TRIPS (3) round trips are allowed to complete; the 4th
    // tool-call response is what actually trips the bound (checked before
    // executing it), so the provider is called 4 times, not 3.
    expect(completeWithTools).toHaveBeenCalledTimes(4);
  });

  // Eval A2 (2026-09-29, commerce-roundtrip-cap tripped at 53%): lookup ->
  // create_order -> a corrective create_order needs three round trips.
  it('lets a turn complete THREE tool round trips and then answer', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'a' }))
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'b' }))
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'c' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('done');
    expect(completeWithTools).toHaveBeenCalledTimes(4);
  });

  it('escalates TOOL_SCOPE_VIOLATION when authorize() rejects the tool', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(toolCallResult('echo', { message: 'hi' }));
    const { toolExecution } = makeToolExecution({
      authorize: jest.fn().mockRejectedValue(new ToolScopeViolation()),
    });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('TOOL_SCOPE_VIOLATION');
    expect(result.escalationSource).toBe('error_forced');
  });

  it('a malformed tool call (bad args) consumes the corrective budget, then can still succeed', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: '' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution } = makeToolExecution({
      authorize: jest.fn().mockRejectedValueOnce(new LLMMalformedToolCall()),
    });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(result.answer).toBe('done');
  });
});

describe('AgentRuntime.respond() — respond payload validation', () => {
  it('an invalid respond payload consumes the corrective budget, then can still succeed', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(
        respondResult({
          answer: '',
          cited_chunk_ids: [],
          confidence: 2,
          escalate: false,
        }),
      )
      .mockResolvedValueOnce(
        respondResult({
          answer: 'ok',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.answer).toBe('ok');
    expect(completeWithTools).toHaveBeenCalledTimes(2);
  });

  it('escalates LLM_ERROR once an invalid respond payload persists past the corrective budget', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: '',
        cited_chunk_ids: [],
        confidence: 2,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationDetail).toBe('invalid_respond_payload');
    expect(completeWithTools).toHaveBeenCalledTimes(3);
  });

  it('accepts a COMPLETE respond payload the model wrote as text instead of calling the tool, without spending a retry', async () => {
    // Measured 2026-08-16 (multi-doc-synthesis, 3/3 runs): the model produced
    // exactly this on its FIRST call, the loop ignored it, and the turn died as
    // an LLM_ERROR two calls later. See respond-text-fallback.ts.
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(
        plainTextResult(
          'Cash on delivery is capped at 50,000 BDT.\n\n' +
            'cited_chunk_ids: ["c1", "c2"]\nconfidence: 1.0\nescalate: false',
        ),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('Cash on delivery is capped at 50,000 BDT.');
    expect(result.citedChunkIds).toEqual(['chunk-1', 'chunk-2']);
    expect(result.confidence).toBe(1);
  });

  it('still guards a salvaged payload: a fabricated citation in text is caught exactly as in a tool call', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(
        plainTextResult(
          'Refunds take 5 days.\n\ncited_chunk_ids: ["c9"]\nconfidence: 1.0\nescalate: false',
        ),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.isHallucination).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
  });

  it('a plain-text response with no tool call at all is treated as a corrective case, not a silent drop', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(
        plainTextResult('Sure, here is an answer without calling respond.'),
      )
      .mockResolvedValueOnce(
        respondResult({
          answer: 'ok',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.answer).toBe('ok');
  });
});

describe('AgentRuntime.respond() — D10 composite confidence', () => {
  it('zero cited chunks forces confidence to 0 and escalates CONFIDENCE_BELOW_THRESHOLD', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'guessing',
        cited_chunk_ids: [],
        confidence: 0.95,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(result.isHallucination).toBe(false);
  });

  it('a tool-grounded answer with zero citations keeps the model confidence and is not escalated', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'It costs what the tool said.',
          cited_chunk_ids: [],
          confidence: 0.85,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.confidence).toBe(0.85);
    expect(result.escalate).toBe(false);
    expect(result.isHallucination).toBe(false);
  });

  it('a fabricated handle among REAL retrieved chunks stays a hallucination even when a tool ran', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'Refunds take 5 days.',
          cited_chunk_ids: ['c1', 'c9'],
          confidence: 0.95,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.isHallucination).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
  });

  it('a tool call that failed validation does not count as tool evidence', async () => {
    const execute = jest.fn();
    const authorize = jest.fn().mockRejectedValue(new LLMMalformedToolCall());
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { bad: true }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'guessing',
          cited_chunk_ids: [],
          confidence: 0.95,
          escalate: false,
        }),
      );
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });

  it('a fabricated citation forces confidence to 0, escalates, and is flagged as a hallucination', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'guessing',
        cited_chunk_ids: ['c99'],
        confidence: 0.95,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
    expect(result.isHallucination).toBe(true);
  });

  it('confidence below the tenant threshold escalates even with valid citations', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'low confidence',
        cited_chunk_ids: ['c1'],
        confidence: 0.3,
        escalate: false,
      }),
    );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(
      makeInput({
        tenantPolicy: {
          tonePersonaOverride: null,
          forbiddenTopics: [],
          confidenceThreshold: 0.85,
          rerankEnabled: false,
        },
      }),
    );

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });
});

describe('AgentRuntime.respond() — global deadline', () => {
  it('escalates LLM_ERROR without calling the provider when the loop has no time budget', async () => {
    const completeWithTools = jest.fn();
    // deadlineAtMs is computed right before the loop starts, so the loop's
    // first check can only see it passed when the budget itself is zero.
    const { runtime } = makeRuntime({
      completeWithTools,
      deadlineMs: 0,
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('deadline_exceeded');
    expect(completeWithTools).not.toHaveBeenCalled();
  });

  it('starts the loop deadline after retrieval, so slow retrieval does not eat the model budget', async () => {
    const { clock, advance } = makeManualClock();
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Refunds take 5 days.',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    // Retrieval alone takes longer than the whole loop budget (8s).
    const retrievalSearch = makeRetrievalSearch(() => {
      advance(9000);
      return Promise.resolve(RETRIEVAL_RESULT);
    });
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('Refunds take 5 days.');
  });
});

describe('AgentRuntime.respond() — retrieval/prompt wiring', () => {
  it('passes the current message and rerankEnabled flag through to RetrievalSearchService', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const searchSpy = jest.fn(() => Promise.resolve(RETRIEVAL_RESULT));
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(searchSpy),
    });

    await runtime.respond(
      makeInput({ currentMessage: 'When will my order ship?' }),
    );

    expect(searchSpy).toHaveBeenCalledWith(
      TENANT_A,
      'When will my order ship?',
      false,
      // F9 document scope: undefined here means the caller did not scope this
      // agent, which retrieval reads as the whole knowledge base.
      undefined,
      { allowEmpty: true },
    );
  });

  it("passes the agent's document scope through to retrieval", async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const searchSpy = jest.fn(() => Promise.resolve(RETRIEVAL_RESULT));
    const { runtime } = makeRuntime({
      completeWithTools,
      retrievalSearch: makeRetrievalSearch(searchSpy),
    });

    await runtime.respond(
      makeInput({
        currentMessage: 'refund policy?',
        kbDocumentIds: ['doc-1', 'doc-2'],
      }),
    );

    expect(searchSpy).toHaveBeenCalledWith(
      TENANT_A,
      'refund policy?',
      false,
      ['doc-1', 'doc-2'],
      { allowEmpty: true },
    );
  });
});

// A6 (2026-08-17): the output-side grounding net. Two of the three stable-fail
// cases in the 2026-08-17 5-run eval are answers the cited passages do not
// support, at confidence 1 with a real citation — invisible to every other
// guard. See guardrail/answer-grounding.ts for the measured cases.
describe('AgentRuntime.respond() — grounding check (A6)', () => {
  const answeredPayload = {
    answer: 'Yes, you need an appointment for a blood test.',
    cited_chunk_ids: ['c1'],
    confidence: 1,
    escalate: false,
  };

  it('escalates KB_NOT_INDEXED when the cited passages do not cover the question asked', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'NOT_COVERED',
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('KB_NOT_INDEXED');
    expect(result.escalationSource).toBe('agent_decision');
    expect(result.escalationDetail).toBe('grounding_not_covered');
    // The ungrounded answer must NOT reach the customer — the whole point is
    // that this claim was wrong, so the handoff line replaces it.
    expect(result.answer).not.toContain('blood test');
  });

  it('escalates KB_CONFLICT when two cited passages state different applicable rules', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'CONFLICT',
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('KB_CONFLICT');
    expect(result.escalationDetail).toBe('grounding_conflict');
  });

  it('leaves a COVERED turn exactly as the agent produced it', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'COVERED',
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(false);
    expect(result.answer).toBe(answeredPayload.answer);
  });

  // Fail-open is the property that keeps this net from becoming an outage: a
  // verifier that cannot answer must never escalate the turn.
  it('leaves the turn unchanged when the verifier has no opinion', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime } = makeRuntime({
      completeWithTools,
      groundingVerdict: null,
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(false);
  });

  it('passes the QUESTION, the answer and the cited passage text to the verifier', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime, groundingCheck } = makeRuntime({ completeWithTools });

    await runtime.respond(
      makeInput({
        currentMessage: 'do I need an appointment for a blood test',
      }),
    );

    expect(groundingCheck).toHaveBeenCalledWith({
      question: 'do I need an appointment for a blood test',
      answer: answeredPayload.answer,
      citedPassages: ['Refunds take 5 days.'],
      otherRetrievedPassages: ['Shipping takes 3-5 days.'],
      toolResultPassages: [],
    });
  });

  // multi-doc-synthesis#3 (EMI), refund-policy#2: the answer rests on a chunk
  // it did not cite (price in one, EMI threshold in another). Judged on the
  // cited chunk alone the inference reads as unsupported.
  it('shows the verifier the retrieved chunks the agent did NOT cite, separately from the cited ones', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime, groundingCheck } = makeRuntime({ completeWithTools });

    await runtime.respond(makeInput());

    const call = (
      groundingCheck.mock.calls as Array<
        [{ citedPassages: string[]; otherRetrievedPassages: string[] }]
      >
    )[0][0];
    expect(call.citedPassages).toEqual(['Refunds take 5 days.']);
    expect(call.otherRetrievedPassages).toEqual(['Shipping takes 3-5 days.']);
  });

  it("gives the verifier this turn's tool results alongside the cited passages", async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(respondResult(answeredPayload));
    const { toolExecution, execute } = makeToolExecution();
    execute.mockResolvedValue({ products: [{ name: 'Orbit V3' }] });
    const { runtime, groundingCheck } = makeRuntime({
      completeWithTools,
      toolExecution,
    });

    await runtime.respond(makeInput());

    // A mixed answer (catalog price + KB delivery policy) must not be judged
    // NOT_COVERED just because the price is in a tool result, not a chunk.
    // Tool results travel in their OWN channel so the verifier labels them
    // [tool result N]; folded into the passages they read as a "passage" no
    // policy document backs (commerce-tracking#2/#18, order confirmations).
    expect(groundingCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        citedPassages: ['Refunds take 5 days.'],
        toolResultPassages: [
          JSON.stringify({ products: [{ name: 'Orbit V3' }] }),
        ],
      }),
    );
  });

  it('passes the results of EVERY tool round trip of the turn, in order (create_order, then track_order)', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'one' }))
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'two' }))
      .mockResolvedValueOnce(respondResult(answeredPayload));
    const { toolExecution, execute } = makeToolExecution();
    execute
      .mockResolvedValueOnce({ orderReference: 'ORD-1', total: 4500 })
      .mockResolvedValueOnce({ shipments: [{ status: 'out_for_delivery' }] });
    const { runtime, groundingCheck } = makeRuntime({
      completeWithTools,
      toolExecution,
    });

    await runtime.respond(makeInput());

    expect(groundingCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        toolResultPassages: [
          JSON.stringify({ orderReference: 'ORD-1', total: 4500 }),
          JSON.stringify({ shipments: [{ status: 'out_for_delivery' }] }),
        ],
      }),
    );
  });

  // Hallucination protection must survive the widened evidence: the draft is
  // still overridden when the verifier says a fact is in no source, tool
  // results or not, and the handoff line replaces it.
  it('still escalates an answer with a fact in neither the KB nor the tool output, even with tool results present', async () => {
    const inventedPayload = {
      answer: 'Your order ORD-1 is placed, and delivery is free for life.',
      cited_chunk_ids: ['c1'],
      confidence: 1,
      escalate: false,
    };
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockResolvedValueOnce(respondResult(inventedPayload));
    const { toolExecution, execute } = makeToolExecution();
    execute.mockResolvedValue({ orderReference: 'ORD-1' });
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      groundingVerdict: 'NOT_COVERED',
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationDetail).toBe('grounding_not_covered');
    expect(result.answer).not.toContain('free for life');
  });

  // The override discards the draft; without a log nobody can tell a false
  // override from a correct catch (cycle 3: ~34 unexplained turns).
  it.each(['NOT_COVERED', 'CONFLICT'] as const)(
    'logs the pre-override draft answer on a %s verdict',
    async (verdict) => {
      const completeWithTools = jest
        .fn()
        .mockResolvedValue(respondResult(answeredPayload));
      const { runtime, logger } = makeRuntime({
        completeWithTools,
        groundingVerdict: verdict,
      });

      await runtime.respond(makeInput());

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(answeredPayload.answer),
        'AgentRuntime',
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`verdict=${verdict}`),
        'AgentRuntime',
      );
    },
  );

  it('logs nothing about grounding when the answer is COVERED', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime, logger } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'COVERED',
    });

    await runtime.respond(makeInput());

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('truncates a very long draft in the log line', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        ...answeredPayload,
        answer: `START ${'x'.repeat(5000)}`,
      }),
    );
    const { runtime, logger } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'NOT_COVERED',
    });

    await runtime.respond(makeInput());

    const message = (logger.warn.mock.calls[0] as [string])[0];
    expect(message).toContain('START');
    expect(message.length).toBeLessThan(1200);
  });

  describe('on a tool-grounded answer with zero citations', () => {
    const toolOnlyPayload = {
      answer: 'The Orbit V3 is in stock.',
      cited_chunk_ids: [],
      confidence: 0.9,
      escalate: false,
    };
    const NO_MATCH = { products: [], message: 'No matching products found' };

    function toolThenRespond() {
      return jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
        .mockResolvedValueOnce(respondResult(toolOnlyPayload));
    }

    it('checks the answer against the tool results alone', async () => {
      const { toolExecution, execute } = makeToolExecution();
      execute.mockResolvedValue(NO_MATCH);
      const { runtime, groundingCheck } = makeRuntime({
        completeWithTools: toolThenRespond(),
        toolExecution,
      });

      await runtime.respond(makeInput());

      expect(groundingCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          answer: toolOnlyPayload.answer,
          citedPassages: [],
          // Nothing cited: the uncited chunks are NOT offered as grounding.
          otherRetrievedPassages: [],
          toolResultPassages: [JSON.stringify(NO_MATCH)],
        }),
      );
    });

    // Review finding (2026-09-28): "a tool ran" is not "the tool supplied the
    // answer". A no-match lookup followed by an uncited policy answer must not
    // get past both D10 and A6.
    it('escalates when the tool results do not cover the answer', async () => {
      const { toolExecution, execute } = makeToolExecution();
      execute.mockResolvedValue(NO_MATCH);
      const { runtime } = makeRuntime({
        completeWithTools: toolThenRespond(),
        toolExecution,
        groundingVerdict: 'NOT_COVERED',
      });

      const result = await runtime.respond(makeInput());

      expect(result.escalate).toBe(true);
      expect(result.escalationReason).toBe('KB_NOT_INDEXED');
      expect(result.escalationDetail).toBe('grounding_not_covered');
    });
  });

  it('does not run on a turn that is already escalating (a human is involved either way)', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Let me get a human.',
        cited_chunk_ids: ['c1'],
        confidence: 1,
        escalate: true,
        escalation_reason: 'EXPLICIT_USER_REQUEST',
      }),
    );
    const { runtime, groundingCheck } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'NOT_COVERED',
    });

    const result = await runtime.respond(makeInput());

    expect(groundingCheck).not.toHaveBeenCalled();
    expect(result.escalationReason).toBe('EXPLICIT_USER_REQUEST');
  });

  it('does not run when nothing was cited (D10 zero-citation override owns that case)', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Hi! How can I help?',
        cited_chunk_ids: [],
        confidence: 1,
        escalate: false,
        no_kb_needed: true,
      }),
    );
    const { runtime, groundingCheck } = makeRuntime({ completeWithTools });

    await runtime.respond(makeInput());

    expect(groundingCheck).not.toHaveBeenCalled();
  });

  it('does not run when the flag is off', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime, groundingCheck } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'NOT_COVERED',
      groundingCheckEnabled: false,
    });

    const result = await runtime.respond(makeInput());

    expect(groundingCheck).not.toHaveBeenCalled();
    expect(result.escalate).toBe(false);
  });

  // D6's wall clock is the wall clock. A guard may not be the thing that
  // blows it.
  it('is skipped once the loop deadline has passed', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime, groundingCheck } = makeRuntime({
      completeWithTools,
      groundingVerdict: 'NOT_COVERED',
      deadlineMs: 100,
      // Loop entry and provider call are inside the deadline; by the time the
      // grounding gate is reached the clock is past it. D3 (2026-09-17): the
      // leading extra 0 accounts for deadlineAtMs now being computed after
      // the (skipped, text-only) media pre-pass — one more nowMs() call than
      // before, at the same value, so the deadline itself is unchanged. The
      // provider call now reads the clock to bound itself by the time left
      // (eval I2), so its start must fall inside the deadline too (40).
      clockValues: [0, 0, 0, 0, 10, 20, 30, 40, 5000, 5000, 5000, 5000],
    });

    const result = await runtime.respond(makeInput());

    expect(groundingCheck).not.toHaveBeenCalled();
    expect(result.escalate).toBe(false);
  });

  it('adds the check’s tokens and its own span to the turn’s telemetry', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(respondResult(answeredPayload));
    const { runtime, groundingCheck } = makeRuntime({ completeWithTools });
    groundingCheck.mockResolvedValue({
      verdict: 'COVERED',
      usage: { inputTokens: 700, outputTokens: 3 },
    });

    const result = await runtime.respond(makeInput());

    expect(result.telemetry.inputTokens).toBe(710);
    expect(result.telemetry.outputTokens).toBe(8);
  });
});

/** A clock the test drives: a mock (a slow tool, a slow provider call) calls `advance()` to move time on. */
function makeManualClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  return {
    clock: { now: () => new Date(now), nowMs: () => now },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface SentMessage {
  role: string;
  content: string;
  toolCalls?: Array<{ id: string }>;
  toolCallId?: string;
}

function sentMessages(
  completeWithTools: jest.Mock,
  callIndex: number,
): SentMessage[] {
  const calls = completeWithTools.mock.calls as unknown as Array<
    [{ messages: SentMessage[] }]
  >;
  return calls[callIndex]?.[0].messages ?? [];
}

/** OpenAI-compatible providers reject a history where an assistant `tool_calls` message is not followed by one `tool` message per call id (HTTP 400). */
function expectEveryToolCallAnswered(messages: SentMessage[]): void {
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !message.toolCalls?.length) return;
    const ids = message.toolCalls.map((call) => call.id);
    const following = messages.slice(index + 1, index + 1 + ids.length);
    expect(following.map((m) => m.role)).toEqual(ids.map(() => 'tool'));
    expect(following.map((m) => m.toolCallId).sort()).toEqual([...ids].sort());
  });
}

function batchResult(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): LlmToolResult {
  return {
    content: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: calls,
  };
}

const ORDER_RESULT = {
  status: 'confirmed',
  orderReference: 'ORD-1001',
  customerMessage: 'order_placed_cash_on_delivery',
  duplicate: false,
};

/** A tool result that wrote nothing and is not an order: a give-up after it must stay an escalation. */
const LOOKUP_RESULT = { found: 'Tent, 299 SAR' };

const ORDER_CONFIRMATION_PAYLOAD = {
  answer: 'Your order ORD-1001 is placed, cash on delivery.',
  cited_chunk_ids: [],
  confidence: 0.9,
  escalate: false,
};

describe('AgentRuntime.respond() — deadline after a tool has already run', () => {
  function slowToolExecution(
    advance: (ms: number) => void,
    byMs: number,
    toolResult: Record<string, unknown> = ORDER_RESULT,
  ): { toolExecution: ToolExecutionService; execute: jest.Mock } {
    const execute = jest.fn(() => {
      advance(byMs);
      return Promise.resolve(toolResult);
    });
    return {
      toolExecution: makeToolExecution({ execute }).toolExecution,
      execute,
    };
  }

  it('makes one final respond call so the customer hears what a completed tool did', async () => {
    const { clock, advance } = makeManualClock();
    const { toolExecution } = slowToolExecution(advance, 9000);
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
      .mockResolvedValueOnce(respondResult(ORDER_CONFIRMATION_PAYLOAD));
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(false);
    expect(result.answer).toBe(ORDER_CONFIRMATION_PAYLOAD.answer);
    expect(completeWithTools).toHaveBeenCalledTimes(2);
    const finalRequest = sentMessages(completeWithTools, 1);
    expect(
      finalRequest.some(
        (m) => m.role === 'tool' && m.content.includes('ORD-1001'),
      ),
    ).toBe(true);
    expectEveryToolCallAnswered(finalRequest);
  });

  it('still runs the A6 grounding check on the final answer, with the tool results as evidence', async () => {
    const { clock, advance } = makeManualClock();
    const { toolExecution } = slowToolExecution(advance, 9000);
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
      .mockResolvedValueOnce(respondResult(ORDER_CONFIRMATION_PAYLOAD));
    const { runtime, groundingCheck } = makeRuntime({
      completeWithTools,
      toolExecution,
      clock,
      deadlineMs: 8000,
      groundingVerdict: 'NOT_COVERED',
    });

    const result = await runtime.respond(makeInput());

    expect(groundingCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        toolResultPassages: [JSON.stringify(ORDER_RESULT)],
      }),
    );
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('KB_NOT_INDEXED');
    expect(result.escalationSource).toBe('agent_decision');
  });

  it('allows exactly ONE final call: a further tool call escalates instead of executing', async () => {
    const { clock, advance } = makeManualClock();
    const { toolExecution, execute } = slowToolExecution(
      advance,
      9000,
      LOOKUP_RESULT,
    );
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(toolCallResult('create_order', { items: [] }));
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('deadline_exceeded_after_tool');
  });

  it('spends no corrective retry on an invalid final payload', async () => {
    const { clock, advance } = makeManualClock();
    const { toolExecution } = slowToolExecution(advance, 9000, LOOKUP_RESULT);
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
      .mockResolvedValue(respondResult({ answer: 'missing fields' }));
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(2);
    expect(result.escalate).toBe(true);
    expect(result.escalationSource).toBe('error_forced');
  });

  it('does not start the final call once the hard cap (deadline + grace) has passed', async () => {
    const { clock, advance } = makeManualClock();
    const { toolExecution } = slowToolExecution(
      advance,
      8000 + FINAL_RESPOND_GRACE_MS,
      LOOKUP_RESULT,
    );
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
      .mockResolvedValueOnce(respondResult(ORDER_CONFIRMATION_PAYLOAD));
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('deadline_exceeded_after_tool');
  });

  describe('deterministic confirmation of an order that was already written', () => {
    const CREATED_ORDER = {
      status: 'pending_approval',
      orderReference: 'ORD-2002',
      total: '398.00',
      currency: 'SAR',
      items: [{ name: 'Falcon X200 Red', quantity: 2, unitPrice: '199.00' }],
      customerMessage: 'not_yet_placed_awaiting_merchant_confirmation',
      duplicate: false,
    };

    function expectConfirmation(result: {
      escalate: boolean;
      escalationReason: unknown;
      escalationSource: unknown;
      answer: string;
    }): void {
      expect(result.escalate).toBe(false);
      expect(result.escalationReason).toBeNull();
      expect(result.escalationSource).toBeNull();
      expect(result.answer).toContain('ORD-2002');
      expect(result.answer).toContain('2 × Falcon X200 Red');
      expect(result.answer).toContain('398.00 SAR');
      // pending_approval: recorded and awaiting the team, never "placed".
      expect(result.answer).not.toMatch(/placed|paid|shipped/i);
    }

    it('confirms from the order row when the hard cap has passed before the final call could start', async () => {
      const { clock, advance } = makeManualClock();
      const { toolExecution } = slowToolExecution(
        advance,
        8000 + FINAL_RESPOND_GRACE_MS,
        CREATED_ORDER,
      );
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }));
      const { runtime, logger } = makeRuntime({
        completeWithTools,
        toolExecution,
        clock,
        deadlineMs: 8000,
      });

      const result = await runtime.respond(makeInput());

      expect(completeWithTools).toHaveBeenCalledTimes(1);
      expectConfirmation(result);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('deadline_exceeded_after_tool'),
        'AgentRuntime',
      );
    });

    it('confirms from the order row when the final respond call itself times out', async () => {
      const { clock, advance } = makeManualClock();
      const { toolExecution } = slowToolExecution(advance, 9000, CREATED_ORDER);
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
        .mockRejectedValueOnce(new LLMTimeout());
      const { runtime } = makeRuntime({
        completeWithTools,
        toolExecution,
        clock,
        deadlineMs: 8000,
      });

      const result = await runtime.respond(makeInput());

      expect(completeWithTools).toHaveBeenCalledTimes(2);
      expectConfirmation(result);
    });

    it('confirms from the order row when the final call asks for another tool or sends an invalid payload', async () => {
      for (const finalCall of [
        toolCallResult('create_order', { items: [] }),
        respondResult({ answer: 'missing fields' }),
      ]) {
        const { clock, advance } = makeManualClock();
        const { toolExecution } = slowToolExecution(
          advance,
          9000,
          CREATED_ORDER,
        );
        const completeWithTools = jest
          .fn()
          .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
          .mockResolvedValueOnce(finalCall);
        const { runtime } = makeRuntime({
          completeWithTools,
          toolExecution,
          clock,
          deadlineMs: 8000,
        });

        expectConfirmation(await runtime.respond(makeInput()));
      }
    });

    it('answers in Arabic when the customer wrote in Arabic', async () => {
      const { clock, advance } = makeManualClock();
      const { toolExecution } = slowToolExecution(
        advance,
        8000 + FINAL_RESPOND_GRACE_MS,
        CREATED_ORDER,
      );
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }));
      const { runtime } = makeRuntime({
        completeWithTools,
        toolExecution,
        clock,
        deadlineMs: 8000,
      });

      const result = await runtime.respond(
        makeInput({ currentMessage: 'أكد الطلب من فضلك' }),
      );

      expect(result.escalate).toBe(false);
      expect(result.answer).toContain('ORD-2002');
      expect(result.answer).toContain('طلبك');
    });

    it('still escalates when the tool that ran was a refused create_order, not a written order', async () => {
      const { clock, advance } = makeManualClock();
      const { toolExecution } = slowToolExecution(
        advance,
        8000 + FINAL_RESPOND_GRACE_MS,
        { status: 'refused', reason: 'unknown_product' },
      );
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }));
      const { runtime } = makeRuntime({
        completeWithTools,
        toolExecution,
        clock,
        deadlineMs: 8000,
      });

      const result = await runtime.respond(makeInput());

      expect(result.escalate).toBe(true);
      expect(result.escalationDetail).toBe('deadline_exceeded_after_tool');
    });

    it('does not override a grounding verdict on the model final answer', async () => {
      const { clock, advance } = makeManualClock();
      const { toolExecution } = slowToolExecution(advance, 9000, CREATED_ORDER);
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }))
        .mockResolvedValueOnce(respondResult(ORDER_CONFIRMATION_PAYLOAD));
      const { runtime } = makeRuntime({
        completeWithTools,
        toolExecution,
        clock,
        deadlineMs: 8000,
        groundingVerdict: 'NOT_COVERED',
      });

      const result = await runtime.respond(makeInput());

      expect(result.escalate).toBe(true);
      expect(result.escalationSource).toBe('agent_decision');
    });
  });

  it('keeps plain deadline_exceeded when no tool produced anything this turn', async () => {
    const { clock, advance } = makeManualClock();
    const completeWithTools = jest.fn(() => {
      advance(9000);
      return Promise.resolve(toolCallResult('echo', { bad: true }));
    });
    const { toolExecution } = makeToolExecution({
      authorize: jest.fn().mockRejectedValue(new LLMMalformedToolCall()),
    });
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.escalationDetail).toBe('deadline_exceeded');
  });
});

// Eval I2 (2026-09-29): turns ran 37-64s against an 8s loop deadline. The
// deadline was only checked BEFORE a provider call, so a call started at 7.9s
// could run its full LLM_REQUEST_TIMEOUT_MS and then be retried (backoff + a
// second full timeout) without ever consulting the deadline again.
describe('AgentRuntime.respond() — deadline bounds a single provider call', () => {
  it('does not retry a timed-out call once the deadline has passed', async () => {
    const { clock, advance } = makeManualClock();
    const completeWithTools = jest.fn(() => {
      advance(9000);
      return Promise.reject(new LLMTimeout());
    });
    const { runtime, wait } = makeRuntime({
      completeWithTools,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('deadline_exceeded');
  });

  it('does not sleep the retry backoff when it would run past the deadline', async () => {
    const { clock, advance } = makeManualClock();
    const completeWithTools = jest.fn(() => {
      advance(7800);
      return Promise.reject(new LLMTimeout());
    });
    const { runtime, wait } = makeRuntime({
      completeWithTools,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    // 7800 + 500ms backoff >= 8000: the retry could only start past the wall.
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(result.escalationReason).toBe('LLM_ERROR');
  });

  it('abandons a call that outlives the deadline instead of waiting out the provider timeout', async () => {
    const { clock, advance } = makeManualClock();
    const completeWithTools = jest.fn(() => {
      // Time passes and the provider never answers.
      advance(60);
      return new Promise<never>(() => undefined);
    });
    const { runtime } = makeRuntime({
      completeWithTools,
      clock,
      deadlineMs: 50,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('deadline_exceeded');
  });

  it('after a tool ran, a call that times out past the deadline still gets the one final respond', async () => {
    const { clock, advance } = makeManualClock();
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: 'hi' }))
      .mockImplementationOnce(() => {
        advance(9000);
        return Promise.reject(new LLMTimeout());
      })
      .mockResolvedValueOnce(
        respondResult({
          answer: 'Your order is registered.',
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({
      completeWithTools,
      clock,
      deadlineMs: 8000,
    });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(3);
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('Your order is registered.');
  });
});

describe('AgentRuntime.respond() — every tool_call id gets a tool result', () => {
  it('answers a malformed call with a tool message before the corrective guidance', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('echo', { message: '' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution } = makeToolExecution({
      authorize: jest.fn().mockRejectedValueOnce(new LLMMalformedToolCall()),
    });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    await runtime.respond(makeInput());

    const retry = sentMessages(completeWithTools, 1);
    expectEveryToolCallAnswered(retry);
    const toolMessage = retry.find((m) => m.role === 'tool');
    expect(toolMessage?.toolCallId).toBe('call-echo');
    expect(toolMessage?.content).toMatch(/invalid arguments/i);
    expect(retry[retry.length - 1]?.role).toBe('user');
  });

  it('keeps the results of the calls in a batch that DID execute when another is malformed', async () => {
    const authorize = jest
      .fn()
      .mockResolvedValueOnce({ message: 'ok' })
      .mockRejectedValueOnce(new LLMMalformedToolCall());
    const execute = jest.fn().mockResolvedValue({ found: 'Tent, 299 SAR' });
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(
        batchResult([
          { id: 'call-a', name: 'echo', input: { message: 'ok' } },
          { id: 'call-b', name: 'echo', input: { message: '' } },
        ]),
      )
      .mockResolvedValueOnce(
        respondResult({
          answer: 'The tent is 299 SAR.',
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    const retry = sentMessages(completeWithTools, 1);
    expectEveryToolCallAnswered(retry);
    expect(retry.find((m) => m.toolCallId === 'call-a')?.content).toContain(
      'Tent, 299 SAR',
    );
    expect(retry.find((m) => m.toolCallId === 'call-b')?.content).toMatch(
      /invalid arguments/i,
    );
    // The executed call is tool evidence: D10's zero-citation override is waived.
    expect(result.escalate).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('authorizes the whole batch before executing any of it', async () => {
    const authorize = jest
      .fn()
      .mockResolvedValueOnce({ message: 'ok' })
      .mockRejectedValueOnce(new ToolScopeViolation());
    const execute = jest.fn().mockResolvedValue({ ok: true });
    const completeWithTools = jest.fn().mockResolvedValueOnce(
      batchResult([
        { id: 'call-a', name: 'echo', input: { message: 'ok' } },
        { id: 'call-b', name: 'echo', input: { message: 'x' } },
      ]),
    );
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('TOOL_SCOPE_VIOLATION');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not escalate a spent corrective budget when another call in the batch already executed', async () => {
    const authorize = jest
      .fn()
      .mockResolvedValueOnce({ message: 'ok' })
      .mockRejectedValueOnce(new LLMMalformedToolCall());
    const execute = jest.fn().mockResolvedValue(ORDER_RESULT);
    const completeWithTools = jest
      .fn()
      .mockRejectedValueOnce(new LLMMalformedToolCall())
      .mockRejectedValueOnce(new LLMMalformedToolCall())
      .mockResolvedValueOnce(
        batchResult([
          { id: 'call-a', name: 'create_order', input: { items: [] } },
          { id: 'call-b', name: 'echo', input: { message: '' } },
        ]),
      )
      .mockResolvedValueOnce(respondResult(ORDER_CONFIRMATION_PAYLOAD));
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe(ORDER_CONFIRMATION_PAYLOAD.answer);
    expectEveryToolCallAnswered(sentMessages(completeWithTools, 3));
  });

  it('answers every other tool call in a batch whose respond payload was invalid', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(
        batchResult([
          { id: 'call-x', name: 'echo', input: { message: 'hi' } },
          { id: 'call-respond', name: RESPOND_TOOL_NAME, input: {} },
        ]),
      )
      .mockResolvedValueOnce(
        respondResult({
          answer: 'done',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    await runtime.respond(makeInput());

    const retry = sentMessages(completeWithTools, 1);
    expectEveryToolCallAnswered(retry);
    expect(retry.find((m) => m.toolCallId === 'call-respond')?.content).toMatch(
      /Invalid respond arguments/,
    );
  });
});

describe('AgentRuntime.respond() — a rejected tool call spends no round trip', () => {
  it('lets an empty create_order be rejected without using up one of the tool round trips', async () => {
    // The empty call, then three real lookups: the cap is 3 round trips, and
    // the rejected call must not be one of them.
    const authorize = jest
      .fn()
      .mockRejectedValueOnce(new LLMMalformedToolCall())
      .mockResolvedValue({ message: 'hi' });
    const execute = jest.fn().mockResolvedValue({ found: 'Tent, 299 SAR' });
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('create_order', {}))
      .mockResolvedValueOnce(toolCallResult('lookup_product', { q: 'a' }))
      .mockResolvedValueOnce(toolCallResult('lookup_product', { q: 'b' }))
      .mockResolvedValueOnce(toolCallResult('lookup_product', { q: 'c' }))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'The tent is 299 SAR.',
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.escalate).toBe(false);
    expect(result.escalationDetail).toBeUndefined();
    expect(result.answer).toBe('The tent is 299 SAR.');
  });

  it('still bounds repeated empty calls by the corrective budget', async () => {
    const authorize = jest.fn().mockRejectedValue(new LLMMalformedToolCall());
    const execute = jest.fn();
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(toolCallResult('create_order', {}));
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(execute).not.toHaveBeenCalled();
    expect(result.escalate).toBe(true);
    expect(result.escalationDetail).toBe('malformed_tool_args');
  });
});

describe('AgentRuntime.respond() — cycle 3 deterministic escalation nets', () => {
  const NOW = Date.parse('2026-09-30T08:00:00Z');
  const fixedClock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

  const PEANUT_QUESTION =
    'my nephew has a severe peanut allergy. Is the kacchi biryani safe for him?';

  describe('safety risk (allergy / health): catering-quotes#7, missed in 2 of 5 runs', () => {
    it('escalates even though the model answered confidently, cited a chunk and did not escalate', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: 'Yes, it is safe for him. The kacchi biryani is peanut-free.',
          cited_chunk_ids: ['c1'],
          confidence: 1,
          escalate: false,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({ currentMessage: PEANUT_QUESTION }),
      );

      expect(result.escalate).toBe(true);
      expect(result.escalationReason).toBe('CUSTOMER_DISTRESS');
      expect(result.escalationSource).toBe('agent_decision');
    });

    it('does not deliver the model’s safety assurance: the draft is replaced by the deterministic handoff', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: 'Yes, it is safe for him. The kacchi biryani is peanut-free.',
          cited_chunk_ids: ['c1'],
          confidence: 1,
          escalate: false,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({ currentMessage: PEANUT_QUESTION }),
      );

      expect(result.answer).not.toMatch(/safe for him|peanut-free/i);
      expect(result.answer).toMatch(/can't confirm allergy or health safety/i);
    });

    it('answers a Gulf Arabic allergy message with the Arabic handoff', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: 'Yes, it is safe.',
          cited_chunk_ids: ['c1'],
          confidence: 1,
          escalate: false,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({
          currentMessage: 'ابني عنده حساسية من الفول السوداني، البرياني آمن؟',
        }),
      );

      expect(result.escalate).toBe(true);
      expect(result.answer).toMatch(/[؀-ۿ]/);
      expect(result.answer).not.toMatch(/it is safe/i);
    });

    it('keeps the model’s own answer when it already escalated', async () => {
      const draft =
        'I cannot confirm that any dish is free of peanuts. I will connect you with our operations manager.';
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: draft,
          cited_chunk_ids: ['c1'],
          confidence: 1,
          escalate: true,
          escalation_reason: 'CUSTOMER_COMPLAINT',
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({ currentMessage: PEANUT_QUESTION }),
      );

      expect(result.answer).toBe(draft);
      expect(result.escalate).toBe(true);
      // Safety, not "complaint": the ticket queue reads the reason.
      expect(result.escalationReason).toBe('CUSTOMER_DISTRESS');
    });

    it('escalates a no_kb_needed, zero-citation answer to an allergy message', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: 'No problem, we will take care of it.',
          cited_chunk_ids: [],
          confidence: 1,
          escalate: false,
          no_kb_needed: true,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({ currentMessage: PEANUT_QUESTION }),
      );

      expect(result.escalate).toBe(true);
      expect(result.escalationReason).toBe('CUSTOMER_DISTRESS');
    });

    it('leaves an ordinary food question alone', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: 'The Gold package is 1,500 per head.',
          cited_chunk_ids: ['c1'],
          confidence: 0.9,
          escalate: false,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({ currentMessage: 'How much is the Gold package?' }),
      );

      expect(result.escalate).toBe(false);
      expect(result.answer).toBe('The Gold package is 1,500 per head.');
    });

    it('still escalates a created order confirmed from the order row when the message carried an allergy', async () => {
      const { clock, advance } = makeManualClock();
      const execute = jest.fn(() => {
        advance(8000 + FINAL_RESPOND_GRACE_MS);
        return Promise.resolve({
          status: 'pending_approval',
          orderReference: 'ORD-2002',
          total: '398.00',
          currency: 'SAR',
          items: [
            { name: 'Falcon X200 Red', quantity: 2, unitPrice: '199.00' },
          ],
        });
      });
      const { toolExecution } = makeToolExecution({ execute });
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(toolCallResult('create_order', { items: [] }));
      const { runtime } = makeRuntime({
        completeWithTools,
        toolExecution,
        clock,
        deadlineMs: 8000,
      });

      const result = await runtime.respond(
        makeInput({
          currentMessage:
            'order 2 red X200 please, my son has a nut allergy so no nuts in the box',
        }),
      );

      expect(result.answer).toContain('ORD-2002');
      expect(result.escalate).toBe(true);
      expect(result.escalationReason).toBe('CUSTOMER_DISTRESS');
    });
  });

  describe('late-delivery complaint after track_order: commerce-complaint#6, missed in 3 of 3 runs', () => {
    const OVERDUE_TRACKING = {
      shipments: [
        {
          orderReference: 'ORD-YHJYMW',
          trackingNumber: 'AWB-C-9004',
          courier: 'J&T',
          status: 'out_for_delivery',
          statusAt: '2026-09-30T07:21:11.020Z',
          estimatedDeliveryAt: '2026-09-22T00:00:00.000Z',
          lastLocation: null,
        },
      ],
      guidance: 'These rows are the only source of delivery information.',
    };
    const STATUS_ANSWER = {
      answer: 'Your shipment is out_for_delivery; the estimate was 2026-09-22.',
      cited_chunk_ids: [],
      confidence: 1,
      escalate: false,
    };

    function trackThenRespond(tracking: Record<string, unknown>) {
      const { toolExecution, execute } = makeToolExecution();
      execute.mockResolvedValue(tracking);
      const completeWithTools = jest
        .fn()
        .mockResolvedValueOnce(
          toolCallResult('track_order', { trackingNumber: 'AWB-C-9004' }),
        )
        .mockResolvedValueOnce(respondResult(STATUS_ANSWER));
      return makeRuntime({
        completeWithTools,
        toolExecution,
        clock: fixedClock,
      });
    }

    it('escalates CUSTOMER_COMPLAINT when the customer says it is late and the shipment is 8 days past its estimate', async () => {
      const { runtime } = trackThenRespond(OVERDUE_TRACKING);

      const result = await runtime.respond(
        makeInput({
          currentMessage:
            'طلبيتي رقم AWB-C-9004 متأخرة كثير عن الموعد المتوقع، ليش صارت هالمدة؟',
        }),
      );

      expect(result.escalate).toBe(true);
      expect(result.escalationReason).toBe('CUSTOMER_COMPLAINT');
      expect(result.escalationSource).toBe('agent_decision');
    });

    it('does not escalate a plain status question about the same overdue shipment', async () => {
      const { runtime } = trackThenRespond(OVERDUE_TRACKING);

      const result = await runtime.respond(
        makeInput({ currentMessage: 'where is my order AWB-C-9004' }),
      );

      expect(result.escalate).toBe(false);
    });

    it('does not escalate a lateness message when the shipment is still on schedule', async () => {
      const { runtime } = trackThenRespond({
        shipments: [
          {
            ...OVERDUE_TRACKING.shipments[0],
            status: 'in_transit',
            estimatedDeliveryAt: '2026-10-03T00:00:00.000Z',
          },
        ],
      });

      const result = await runtime.respond(
        makeInput({ currentMessage: 'my order is late, AWB-C-9004' }),
      );

      expect(result.escalate).toBe(false);
    });
  });

  describe('an uncited answer no tool grounds: catering-quotes#13', () => {
    it('escalates a no_kb_needed answer that says the information does not cover the question', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer:
            'The provided information only covers catering services, menus, and pricing. It does not mention photography or stage decoration services.',
          cited_chunk_ids: [],
          confidence: 1,
          escalate: false,
          no_kb_needed: true,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(
        makeInput({
          currentMessage: 'do you also do photography and stage decoration',
        }),
      );

      expect(result.escalate).toBe(true);
      expect(result.confidence).toBe(0);
      expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    });

    it('reports a greeting below 1.0 without escalating it', async () => {
      const completeWithTools = jest.fn().mockResolvedValue(
        respondResult({
          answer: 'Hi! How can I help you today?',
          cited_chunk_ids: [],
          confidence: 1,
          escalate: false,
          no_kb_needed: true,
        }),
      );
      const { runtime } = makeRuntime({ completeWithTools });

      const result = await runtime.respond(makeInput({ currentMessage: 'hi' }));

      expect(result.escalate).toBe(false);
      expect(result.confidence).toBeLessThan(1);
    });
  });
});

describe('AgentRuntime.respond() — respond-only recovery once the corrective budget is spent (cycle 3b)', () => {
  const ASK_FOR_REFERENCE = {
    answer: 'Could you send me your order number or tracking number?',
    cited_chunk_ids: [],
    confidence: 0.9,
    escalate: false,
    no_kb_needed: true,
  };

  function offeredToolNames(completeWithTools: jest.Mock, callIndex: number) {
    const calls = completeWithTools.mock.calls as unknown as Array<
      [{ tools: Array<{ name: string }> }]
    >;
    return calls[callIndex]?.[0].tools.map((tool) => tool.name);
  }

  it('commerce-complaint#8: two empty track_order calls end in a respond-only call, not LLM_ERROR', async () => {
    const authorize = jest.fn().mockRejectedValue(new LLMMalformedToolCall());
    const execute = jest.fn();
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('track_order', {}))
      .mockResolvedValueOnce(toolCallResult('track_order', {}))
      .mockResolvedValueOnce(toolCallResult('track_order', {}))
      .mockResolvedValueOnce(respondResult(ASK_FOR_REFERENCE));
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(execute).not.toHaveBeenCalled();
    expect(completeWithTools).toHaveBeenCalledTimes(4);
    expect(offeredToolNames(completeWithTools, 3)).toEqual([RESPOND_TOOL_NAME]);
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe(ASK_FOR_REFERENCE.answer);
    const recovery = sentMessages(completeWithTools, 3);
    expectEveryToolCallAnswered(recovery);
    expect(recovery[recovery.length - 1]?.content).toMatch(
      /cannot call any more tools/i,
    );
  });

  it('commerce-journey Fahd: a turn that never calls respond gets one respond-only call before it escalates', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(plainTextResult('Please send your address.'))
      .mockResolvedValueOnce(plainTextResult('Please send your address.'))
      .mockResolvedValueOnce(plainTextResult('Please send your address.'))
      .mockResolvedValueOnce(
        respondResult({
          ...ASK_FOR_REFERENCE,
          answer: 'Please send your delivery address.',
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(4);
    expect(offeredToolNames(completeWithTools, 3)).toEqual([RESPOND_TOOL_NAME]);
    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('Please send your delivery address.');
  });

  it('still escalates with the original detail when the recovery call does not respond either', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(plainTextResult('no tool call'));
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(4);
    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('no_respond_call');
  });

  it('never executes a tool the recovery call asks for', async () => {
    const authorize = jest.fn().mockRejectedValue(new LLMMalformedToolCall());
    const execute = jest.fn();
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(toolCallResult('create_order', {}));
    const { toolExecution } = makeToolExecution({ authorize, execute });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    const result = await runtime.respond(makeInput());

    expect(completeWithTools).toHaveBeenCalledTimes(4);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
    expect(result.escalationDetail).toBe('malformed_tool_args');
  });

  it('guards the recovered payload like any other: an uncited KB answer is still zeroed', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(plainTextResult('x'))
      .mockResolvedValueOnce(plainTextResult('x'))
      .mockResolvedValueOnce(plainTextResult('x'))
      .mockResolvedValueOnce(
        respondResult({
          answer: 'Refunds take 5 days.',
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: false,
        }),
      );
    const { runtime } = makeRuntime({ completeWithTools });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });

  it('is not attempted past the loop deadline', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValue(plainTextResult('no tool call'));
    // deadline = 0 + 8000; the 4th top-of-loop/recovery read is past it.
    const { runtime } = makeRuntime({
      completeWithTools,
      clockValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9000],
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalationReason).toBe('LLM_ERROR');
    expect(completeWithTools.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('the corrective message after a rejected call names the way out: ask the customer for the missing detail', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolCallResult('track_order', {}))
      .mockResolvedValueOnce(respondResult(ASK_FOR_REFERENCE));
    const { toolExecution } = makeToolExecution({
      authorize: jest.fn().mockRejectedValueOnce(new LLMMalformedToolCall()),
    });
    const { runtime } = makeRuntime({ completeWithTools, toolExecution });

    await runtime.respond(makeInput());

    const retry = sentMessages(completeWithTools, 1);
    const nudge = retry[retry.length - 1]?.content ?? '';
    expect(nudge).toContain('"track_order"');
    expect(nudge).toMatch(/ask the customer for exactly what is missing/i);
  });
});

describe('AgentRuntime.respond() — track_order found no shipment (cycle 3b, commerce-tracking#14)', () => {
  it('escalates a refusal that did not hand off after track_order returned no shipment', async () => {
    const execute = jest.fn().mockResolvedValue({
      shipments: [],
      message: 'No shipment found for this customer',
      guidance: 'escalate',
    });
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('track_order', { trackingNumber: 'AWB-100-3002' }),
      )
      .mockResolvedValueOnce(
        respondResult({
          answer:
            'I could not find a shipment with that number on your account.',
          cited_chunk_ids: [],
          confidence: 1,
          escalate: false,
        }),
      );
    const { toolExecution } = makeToolExecution({ execute });
    const { runtime } = makeRuntime({
      completeWithTools,
      toolExecution,
      retrievalSearch: makeRetrievalSearch(() =>
        Promise.resolve({ ...RETRIEVAL_RESULT, chunks: [] }),
      ),
    });

    const result = await runtime.respond(makeInput());

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('KB_NOT_INDEXED');
    expect(result.escalationSource).toBe('agent_decision');
  });
});
