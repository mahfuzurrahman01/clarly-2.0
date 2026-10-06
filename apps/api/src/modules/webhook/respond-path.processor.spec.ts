import type { Job } from 'bullmq';
import type { AgentConfigService } from '../agent-config/agent-config.service';
import type { IntakeService } from '../conversation/intake.service';
import type { TenantWebhookService } from '../outbound/tenant-webhook.service';
import type { AgentRuntime } from '../agent/agent-runtime';
import type { AgentTurnResult } from '../agent/agent-turn.dto';
import type { AppLoggerService } from '../core';
import type { ConversationLockService } from '../conversation/conversation-lock.service';
import type { ConversationService } from '../conversation/conversation.service';
import type { SummarizationService } from '../conversation/summarization.service';
import type { CoalescedRespondJobData } from '../conversation/coalesced-respond-job.dto';
import type { CustomerLabelService } from '../customer/customer-label.service';
import type { CustomerService } from '../customer/customer.service';
import type { UsageService } from '../billing/usage.service';
import type { TenantPolicyService } from '../onboarding/tenant-policy.service';
import type { AgentRunService } from '../telemetry/agent-run.service';
import type { TicketEscalationService } from '../ticket/ticket-escalation.service';
import type { ObjectStorage } from '../storage/ports/object-storage.port';
import type { ChannelRegistry } from '../channel/channel-registry.service';
import {
  HANDOVER_AUTO_RETURN_MINUTES,
  RespondPathProcessor,
} from './respond-path.processor';

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = 'conv-1';
const ASSISTANT_MESSAGE_ID = 'message-1';
const AGENT_ID = 'agent-1';
const CUSTOMER_ID = 'customer-1';

function makeJob(
  overrides: Partial<Job<CoalescedRespondJobData>> = {},
): Job<CoalescedRespondJobData> {
  return {
    id: 'job-1',
    data: {
      tenantId: TENANT_A,
      channelAccountId: 'PHONE_NUMBER_ID',
      from: '155',
      messages: [{ providerMessageId: 'wamid.1', text: 'hi' }],
    },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<CoalescedRespondJobData>;
}

function makeAgentResult(
  overrides: Partial<AgentTurnResult> = {},
): AgentTurnResult {
  return {
    answer: 'Refunds take 5 days.',
    citedChunkIds: ['chunk-1'],
    confidence: 0.9,
    escalate: false,
    escalationReason: null,
    escalationSource: null,
    isHallucination: false,
    promptVersion: 'v1',
    telemetry: {
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 250,
      spans: { retrievalMs: 30, llmMs: 200 },
    },
    ...overrides,
  };
}

function makeHarness(agentResult: AgentTurnResult = makeAgentResult()) {
  const withLock = jest.fn(
    (_tenantId: string, _key: string, fn: () => Promise<unknown>) => fn(),
  );
  const conversationLock = { withLock } as unknown as ConversationLockService;

  const getOrCreateByPhone = jest
    .fn()
    .mockResolvedValue({ id: CUSTOMER_ID, tenantId: TENANT_A, phone: '155' });
  const customerService = { getOrCreateByPhone } as unknown as CustomerService;

  // Feature 18: the label write on the respond path. Asserted on directly by
  // the intent-labeling tests below; a no-op stub for every other case.
  const applyAgentSignal = jest.fn().mockResolvedValue(null);
  const customerLabelService = {
    applyAgentSignal,
  } as unknown as CustomerLabelService;

  const getOrCreateConversation = jest.fn().mockResolvedValue({
    id: CONVERSATION_ID,
    tenantId: TENANT_A,
    customerPhone: '155',
    handoverState: 'agent',
    handoverAt: null,
    handoverUserId: null,
    rollingSummary: null,
  });
  const getRecentWindow = jest.fn().mockResolvedValue([]);
  const recordInboundMessages = jest.fn().mockResolvedValue(undefined);
  const recordAssistantMessage = jest
    .fn()
    .mockResolvedValue(ASSISTANT_MESSAGE_ID);
  const attachOutboundDelivery = jest.fn().mockResolvedValue(undefined);
  const returnToAgent = jest.fn().mockResolvedValue(undefined);
  // ISSUE-001: defaults to "a human has replied", i.e. the quiet handover.
  const hasHumanReplySince = jest.fn().mockResolvedValue(true);
  const markHandoverHoldingReplySent = jest.fn().mockResolvedValue(undefined);
  const conversationService = {
    hasHumanReplySince,
    markHandoverHoldingReplySent,
    getOrCreateConversation,
    getRecentWindow,
    recordInboundMessages,
    recordAssistantMessage,
    attachOutboundDelivery,
    returnToAgent,
  } as unknown as ConversationService;

  const getForTenant = jest.fn().mockResolvedValue({
    tenantId: TENANT_A,
    confidenceThreshold: 0.7,
    forbiddenTopics: [],
    tonePersonaOverride: null,
    rerankEnabled: true,
  });
  const tenantPolicyService = {
    getForTenant,
  } as unknown as TenantPolicyService;

  const respond = jest.fn().mockResolvedValue(agentResult);
  const agentRuntime = { respond } as unknown as AgentRuntime;

  const maybeScheduleSummarization = jest.fn().mockResolvedValue(undefined);
  const summarization = {
    maybeScheduleSummarization,
  } as unknown as SummarizationService;

  const createTicket = jest.fn().mockResolvedValue({ id: 'ticket-1' });
  const ticketEscalation = {
    createTicket,
  } as unknown as TicketEscalationService;

  const recordRun = jest.fn().mockResolvedValue(undefined);
  const agentRunService = { recordRun } as unknown as AgentRunService;

  // Defaults to "no enforceable plan" — matches the default
  // BILLING_PROVIDER=none environment, and keeps every existing test
  // exercising the normal AgentRuntime.respond() path. T17-specific tests
  // override this per-test.
  const checkEntitlement = jest.fn().mockResolvedValue({
    allowed: true,
    blockReason: null,
    hasEnforceablePlan: false,
    overMessageLimit: false,
    overSpendCap: false,
    usage: null,
  });
  const usageService = { checkEntitlement } as unknown as UsageService;

  const warn = jest.fn();
  const log = jest.fn();
  const error = jest.fn();
  const logger = { warn, log, error } as unknown as AppLoggerService;

  const sendText = jest
    .fn()
    .mockResolvedValue({ providerMessageId: 'wamid.SENT' });
  // Feature 16: the processor resolves its adapter from the registry by the
  // channel on the job, so the harness fakes the REGISTRY, not one adapter.
  const channels = {
    for: jest.fn().mockReturnValue({ sendText }),
  } as unknown as ChannelRegistry;

  // Mirrors what the backfilled default agent carries, so a turn that runs
  // from agent configuration produces the same prompt input as the legacy
  // tenant_policy row did.
  const resolveForPhoneNumber = jest.fn().mockResolvedValue({
    agentId: AGENT_ID,
    name: 'Default agent',
    configVersion: 1,
    resolvedBy: 'number',
    config: {
      persona: null,
      forbiddenTopics: [],
      confidenceThreshold: 0.7,
      rerankEnabled: true,
      handoverAutoReturnMinutes: 60,
      maxToolCallsPerTurn: 2,
      kbDocumentIds: [],
      businessHours: null,
      timezone: null,
      outOfHoursResponse: null,
      intakeFields: [],
    },
  });
  const agentConfig = {
    resolveForPhoneNumber,
  } as unknown as AgentConfigService;

  const recordIntake = jest.fn().mockResolvedValue({ stored: [], ignored: [] });
  const emitWebhook = jest.fn().mockResolvedValue(0);
  const storageDownload = jest
    .fn()
    .mockResolvedValue(Buffer.from('stored-bytes'));

  const processor = new RespondPathProcessor(
    conversationLock,
    conversationService,
    customerService,
    customerLabelService,
    tenantPolicyService,
    agentRuntime,
    agentConfig,
    { record: recordIntake } as unknown as IntakeService,
    { emit: emitWebhook } as unknown as TenantWebhookService,
    summarization,
    ticketEscalation,
    agentRunService,
    usageService,
    channels,
    // F17: attachment bytes. `download` is only reached by a turn whose
    // coalesced messages carry a media ref — never by the text turns here.
    { download: storageDownload } as unknown as ObjectStorage,
    logger,
  );

  return {
    processor,
    storageDownload,
    applyAgentSignal,
    withLock,
    getOrCreateByPhone,
    getOrCreateConversation,
    getRecentWindow,
    recordInboundMessages,
    recordAssistantMessage,
    attachOutboundDelivery,
    returnToAgent,
    hasHumanReplySince,
    markHandoverHoldingReplySent,
    resolveForPhoneNumber,
    recordIntake,
    emitWebhook,
    getForTenant,
    respond,
    maybeScheduleSummarization,
    createTicket,
    recordRun,
    checkEntitlement,
    sendText,
    warn,
    log,
    error,
  };
}

describe('RespondPathProcessor.process()', () => {
  it('gives the turn a turnId that is the BullMQ job id — stable across retries of the same coalesced burst (F25 D6.2 race #2)', async () => {
    const { processor, respond } = makeHarness();

    // Two attempts of the SAME job: an idempotency key derived from turnId
    // must see one turn, not two. A freshly minted UUID per attempt would
    // make a retry look like a new order.
    await processor.process(makeJob({ id: 'coalesce-tenant-a-window-7' }));
    await processor.process(
      makeJob({ id: 'coalesce-tenant-a-window-7', attemptsMade: 2 }),
    );

    const respondCalls = respond.mock.calls as unknown as Array<
      [{ turnId: string | null }]
    >;
    const turnIds = respondCalls.map((call) => call[0].turnId);
    expect(turnIds).toEqual([
      'coalesce-tenant-a-window-7',
      'coalesce-tenant-a-window-7',
    ]);
  });

  it('runs inside the T10 advisory lock, keyed on (tenantId, from)', async () => {
    const { processor, withLock } = makeHarness();

    await processor.process(makeJob());

    expect(withLock).toHaveBeenCalledWith(
      TENANT_A,
      'tenant-a:155',
      expect.any(Function),
    );
  });

  it('calls AgentRuntime.respond() with prior conversation state and the coalesced messages joined as one currentMessage', async () => {
    const { processor, respond, getRecentWindow } = makeHarness();
    getRecentWindow.mockResolvedValue([
      { role: 'user', content: 'earlier message' },
    ]);

    await processor.process(
      makeJob({
        data: {
          tenantId: TENANT_A,
          from: '155',
          messages: [
            { providerMessageId: 'm1', text: 'hi' },
            { providerMessageId: 'm2', text: 'my order is late' },
          ],
        },
      }),
    );

    expect(respond).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      // F25 D6.1 / F26 D4: the turn identity tools are authorized and
      // executed under, taken from state this method already resolved.
      conversationId: CONVERSATION_ID,
      customerId: CUSTOMER_ID,
      turnId: 'job-1',
      // Empty = the whole knowledge base; this agent is not scoped.
      kbDocumentIds: [],
      // Empty = this agent collects nothing, so L2 renders no intake block.
      intakeInstructions: '',
      conversationSummary: null,
      recentMessages: [{ role: 'user', content: 'earlier message' }],
      currentMessage: 'hi\nmy order is late',
      // F17: empty on a text turn — the media stage is skipped entirely.
      media: [],
      tenantPolicy: {
        tonePersonaOverride: null,
        forbiddenTopics: [],
        confidenceThreshold: 0.7,
        rerankEnabled: true,
      },
    });
  });

  it('records the inbound batch and the reply, in that order relative to reading prior state', async () => {
    const {
      processor,
      recordInboundMessages,
      recordAssistantMessage,
      getRecentWindow,
    } = makeHarness();

    await processor.process(makeJob());

    const readBeforeWrite =
      getRecentWindow.mock.invocationCallOrder[0] <
      recordInboundMessages.mock.invocationCallOrder[0];
    expect(readBeforeWrite).toBe(true);
    expect(recordInboundMessages).toHaveBeenCalledWith(
      TENANT_A,
      CONVERSATION_ID,
      [{ providerMessageId: 'wamid.1', text: 'hi' }],
      expect.any(Date),
    );
    expect(recordAssistantMessage).toHaveBeenCalledWith(
      TENANT_A,
      CONVERSATION_ID,
      'Refunds take 5 days.',
    );
  });

  it('creates a ticket with the real escalation_reason, customerId, and confidence/citations when the turn escalates', async () => {
    const { processor, createTicket } = makeHarness(
      makeAgentResult({
        escalate: true,
        escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        escalationSource: 'agent_decision',
        confidence: 0.2,
        citedChunkIds: ['chunk-1'],
      }),
    );

    await processor.process(makeJob());

    expect(createTicket).toHaveBeenCalledTimes(1);
    const [args] = createTicket.mock.calls[0] as [
      {
        tenantId: string;
        customerId: string;
        conversationId: string;
        escalationReason: string;
        note: string;
        confidence: number | null;
        citedChunkIds: string[] | null;
      },
    ];
    expect(args.tenantId).toBe(TENANT_A);
    expect(args.customerId).toBe(CUSTOMER_ID);
    expect(args.conversationId).toBe(CONVERSATION_ID);
    expect(args.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(args.note).toContain('wamid.1');
    expect(args.confidence).toBe(0.2);
    expect(args.citedChunkIds).toEqual(['chunk-1']);
  });

  it('does not create a ticket when the turn does not escalate', async () => {
    const { processor, createTicket } = makeHarness(
      makeAgentResult({ escalate: false }),
    );

    await processor.process(makeJob());

    expect(createTicket).not.toHaveBeenCalled();
  });

  it('records exactly one agent_runs row with status "success" and the real telemetry when the turn does not escalate (A8)', async () => {
    const { processor, recordRun } = makeHarness(
      makeAgentResult({ escalate: false }),
    );

    await processor.process(makeJob());

    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      conversationId: CONVERSATION_ID,
      ticketId: null,
      status: 'success',
      escalationReason: null,
      escalationSource: null,
      escalationDetail: null,
      agentId: AGENT_ID,
      agentConfigVersion: 1,
      confidence: 0.9,
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 250,
      spans: { retrievalMs: 30, llmMs: 200 },
      promptVersion: 'v1',
      errorMessage: null,
    });
  });

  it('records status "escalated" with the real ticketId when the turn escalates (A8)', async () => {
    const { processor, recordRun } = makeHarness(
      makeAgentResult({
        escalate: true,
        escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        escalationSource: 'agent_decision',
        confidence: 0.2,
      }),
    );

    await processor.process(makeJob());

    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'escalated',
        ticketId: 'ticket-1',
        escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        escalationSource: 'agent_decision',
        confidence: 0.2,
      }),
    );
  });

  // A8: `escalationReason` folds every bounded-loop failure into LLM_ERROR,
  // so the loop's own diagnostic is the only thing that can say WHICH branch
  // gave up. It used to be produced by AgentRuntime and dropped here.
  it('persists the loop-forced escalationDetail onto the agent_runs row (A8)', async () => {
    const { processor, recordRun } = makeHarness(
      makeAgentResult({
        escalate: true,
        escalationReason: 'LLM_ERROR',
        escalationSource: 'error_forced',
        escalationDetail: 'provider_error:LLM_TIMEOUT',
        confidence: 0,
      }),
    );

    await processor.process(makeJob());

    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'escalated',
        escalationReason: 'LLM_ERROR',
        escalationDetail: 'provider_error:LLM_TIMEOUT',
      }),
    );
  });

  // The tone/distress escalation (L0 v3) is model-initiated, not a loop
  // failure — it must reach the ticket + the run row under its own reason,
  // and must NOT acquire a fabricated detail on the way.
  it('carries a CUSTOMER_DISTRESS escalation to both the ticket and the agent_runs row, with a null detail', async () => {
    const { processor, createTicket, recordRun } = makeHarness(
      makeAgentResult({
        escalate: true,
        escalationReason: 'CUSTOMER_DISTRESS',
        escalationSource: 'agent_decision',
        confidence: 0.9,
      }),
    );

    await processor.process(makeJob());

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'CUSTOMER_DISTRESS' }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'escalated',
        escalationReason: 'CUSTOMER_DISTRESS',
        escalationSource: 'agent_decision',
        escalationDetail: null,
        ticketId: 'ticket-1',
      }),
    );
  });

  it('triggers the A7 summarization check after recording the turn', async () => {
    const { processor, maybeScheduleSummarization } = makeHarness();

    await processor.process(makeJob());

    expect(maybeScheduleSummarization).toHaveBeenCalledWith(
      TENANT_A,
      CONVERSATION_ID,
    );
  });

  it('logs the real per-turn latency (T9 "latency metric emitted per response")', async () => {
    const { processor, log } = makeHarness(
      makeAgentResult({
        telemetry: {
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 4321,
          spans: {},
        },
      }),
    );

    await processor.process(makeJob());

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('4321ms'),
      'RespondPathProcessor',
    );
  });

  it('throws when the tenant has neither a published agent nor a policy row, rather than guessing defaults', async () => {
    const { processor, getForTenant, resolveForPhoneNumber, respond } =
      makeHarness();
    resolveForPhoneNumber.mockResolvedValue(null);
    getForTenant.mockResolvedValue(null);

    await expect(processor.process(makeJob())).rejects.toThrow(
      /no tenant_policy row/i,
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it("runs the turn from the agent's published configuration, not the legacy policy row (F9)", async () => {
    const { processor, resolveForPhoneNumber, getForTenant, respond } =
      makeHarness();
    resolveForPhoneNumber.mockResolvedValue({
      agentId: AGENT_ID,
      name: 'Sales agent',
      configVersion: 4,
      resolvedBy: 'number',
      config: {
        persona: 'Warm and brief.',
        forbiddenTopics: ['legal advice'],
        confidenceThreshold: 0.42,
        rerankEnabled: false,
        handoverAutoReturnMinutes: 30,
        maxToolCallsPerTurn: 2,
        kbDocumentIds: [],
        businessHours: null,
        timezone: null,
        outOfHoursResponse: null,
        intakeFields: [],
      },
    });

    await processor.process(makeJob());

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantPolicy: {
          tonePersonaOverride: 'Warm and brief.',
          forbiddenTopics: ['legal advice'],
          confidenceThreshold: 0.42,
          rerankEnabled: false,
        },
      }),
    );
    // The legacy row is not even read when an agent resolves — that is what
    // keeps the two from being two live sources for one value.
    expect(getForTenant).not.toHaveBeenCalled();
  });

  it('falls back to the legacy policy row when no agent resolves, so a tenant with an unbound number keeps answering', async () => {
    const { processor, resolveForPhoneNumber, respond, warn } = makeHarness();
    resolveForPhoneNumber.mockResolvedValue(null);

    await processor.process(makeJob());

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantPolicy: expect.objectContaining({ confidenceThreshold: 0.7 }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy tenant_policy'),
      'RespondPathProcessor',
    );
  });

  it('skips AgentRuntime.respond() entirely and force-escalates when the tenant is over its message limit (T17)', async () => {
    const { processor, respond, checkEntitlement, createTicket, recordRun } =
      makeHarness();
    checkEntitlement.mockResolvedValue({
      allowed: true,
      blockReason: null,
      hasEnforceablePlan: true,
      overMessageLimit: true,
      overSpendCap: false,
      usage: null,
    });

    await processor.process(makeJob());

    expect(respond).not.toHaveBeenCalled();
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'USAGE_CAP_EXCEEDED' }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'escalated',
        escalationReason: 'USAGE_CAP_EXCEEDED',
        inputTokens: 0,
        outputTokens: 0,
        promptVersion: null,
      }),
    );
  });

  it('skips AgentRuntime.respond() entirely and force-escalates when the tenant is over its spend cap (T17)', async () => {
    const { processor, respond, checkEntitlement } = makeHarness();
    checkEntitlement.mockResolvedValue({
      allowed: true,
      blockReason: null,
      hasEnforceablePlan: true,
      overMessageLimit: false,
      overSpendCap: true,
      usage: null,
    });

    await processor.process(makeJob());

    expect(respond).not.toHaveBeenCalled();
  });

  it('calls AgentRuntime.respond() normally when the tenant has no enforceable plan (default BILLING_PROVIDER=none)', async () => {
    const { processor, respond, checkEntitlement } = makeHarness();
    checkEntitlement.mockResolvedValue({
      allowed: true,
      blockReason: null,
      hasEnforceablePlan: false,
      overMessageLimit: true, // irrelevant when hasEnforceablePlan is false
      overSpendCap: false,
      usage: null,
    });

    await processor.process(makeJob());

    expect(respond).toHaveBeenCalled();
  });

  it('calls AgentRuntime.respond() normally when the tenant has an enforceable plan but is under both limits', async () => {
    const { processor, respond, checkEntitlement } = makeHarness();
    checkEntitlement.mockResolvedValue({
      allowed: true,
      blockReason: null,
      hasEnforceablePlan: true,
      overMessageLimit: false,
      overSpendCap: false,
      usage: null,
    });

    await processor.process(makeJob());

    expect(respond).toHaveBeenCalled();
  });

  // Launch billing backend (Lane A): the blocked path — distinct from
  // T17's USAGE_CAP_EXCEEDED (a tenant WITH a working subscription over
  // its own cap, which still runs the "connecting you to a human" reply
  // and a full agent_runs row).
  describe('billing-blocked (Lane A entitlement gate)', () => {
    it('stores the inbound message, opens exactly one ticket, and does nothing else — no LLM call, no outbound send, no agent_runs write', async () => {
      const {
        processor,
        respond,
        checkEntitlement,
        createTicket,
        recordInboundMessages,
        sendText,
        recordRun,
        recordAssistantMessage,
        warn,
      } = makeHarness();
      checkEntitlement.mockResolvedValue({
        allowed: false,
        blockReason: 'no_subscription',
        hasEnforceablePlan: false,
        overMessageLimit: false,
        overSpendCap: false,
        usage: null,
      });

      await processor.process(makeJob());

      expect(recordInboundMessages).toHaveBeenCalledWith(
        TENANT_A,
        CONVERSATION_ID,
        expect.any(Array),
        expect.any(Date),
      );
      expect(createTicket).toHaveBeenCalledTimes(1);
      expect(createTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          escalationReason: 'BILLING_BLOCKED',
          conversationId: CONVERSATION_ID,
          customerId: CUSTOMER_ID,
        }),
      );
      expect(respond).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(recordRun).not.toHaveBeenCalled();
      expect(recordAssistantMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('no_subscription'),
        'RespondPathProcessor',
      );
    });

    it.each([
      'no_subscription',
      'trial_expired',
      'past_due',
      'canceled',
      'incomplete',
    ] as const)('blocks the turn for blockReason=%s', async (blockReason) => {
      const { processor, respond, checkEntitlement } = makeHarness();
      checkEntitlement.mockResolvedValue({
        allowed: false,
        blockReason,
        hasEnforceablePlan: false,
        overMessageLimit: false,
        overSpendCap: false,
        usage: null,
      });

      await processor.process(makeJob());

      expect(respond).not.toHaveBeenCalled();
    });

    it('does not resolve tenant policy (or read recent messages) for a billing-blocked tenant', async () => {
      const { processor, checkEntitlement, getForTenant, getRecentWindow } =
        makeHarness();
      checkEntitlement.mockResolvedValue({
        allowed: false,
        blockReason: 'canceled',
        hasEnforceablePlan: false,
        overMessageLimit: false,
        overSpendCap: false,
        usage: null,
      });

      await processor.process(makeJob());

      // getForTenant() is TenantPolicyService's fallback lookup — resolved
      // only when no agent is found. AgentConfigService.resolveForPhoneNumber
      // itself still runs (isHandedToHuman() needs its
      // handoverAutoReturnMinutes before the billing gate can even be
      // reached), so it is deliberately not asserted un-called here.
      expect(getForTenant).not.toHaveBeenCalled();
      expect(getRecentWindow).not.toHaveBeenCalled();
    });

    it('skips the billing check entirely for a conversation already handed to a human (handover takes priority)', async () => {
      const { processor, getOrCreateConversation, checkEntitlement, respond } =
        makeHarness();
      getOrCreateConversation.mockResolvedValue({
        id: CONVERSATION_ID,
        tenantId: TENANT_A,
        customerPhone: '155',
        handoverState: 'human',
        handoverAt: new Date(),
        handoverUserId: 'user-1',
        rollingSummary: null,
      });

      await processor.process(makeJob());

      expect(checkEntitlement).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    });
  });
});

describe('RespondPathProcessor.onFailed()', () => {
  it('does not escalate to a ticket while attempts remain', async () => {
    const { processor, createTicket } = makeHarness();

    await processor.onFailed(
      makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
      new Error('transient'),
    );

    expect(createTicket).not.toHaveBeenCalled();
  });

  it('drops a job whose payload predates the coalesced shape instead of throwing — an exception here is an unhandled rejection that kills the process', async () => {
    const { processor, createTicket } = makeHarness();
    // The pre-T10 one-message-per-job payload (RespondPathJobData), which can
    // still be sitting in Redis across a deploy: no `messages` array.
    const job = makeJob({
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: {
        tenantId: TENANT_A,
        from: '155',
        providerMessageId: 'wamid.legacy',
        text: 'hi',
      } as unknown as CoalescedRespondJobData,
    });

    await expect(
      processor.onFailed(job, new Error('final failure')),
    ).resolves.toBeUndefined();
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('escalates to a JOB_FAILURE ticket once attempts are exhausted (T11), resolving customer/conversation and listing every coalesced bspMessageId', async () => {
    const {
      processor,
      createTicket,
      getOrCreateByPhone,
      getOrCreateConversation,
    } = makeHarness();
    const job = makeJob({
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: {
        tenantId: TENANT_A,
        from: '155',
        messages: [
          { providerMessageId: 'wamid.1', text: 'hi' },
          { providerMessageId: 'wamid.2', text: 'still there?' },
        ],
      },
    });

    await processor.onFailed(job, new Error('final failure'));

    // Feature 16: the channel travels with the job, so a JOB_FAILURE ticket
    // lands on the right customer identity rather than on a WhatsApp lookalike.
    expect(getOrCreateByPhone).toHaveBeenCalledWith(
      TENANT_A,
      '155',
      'whatsapp',
    );
    expect(getOrCreateConversation).toHaveBeenCalledWith(
      TENANT_A,
      '155',
      undefined,
      'whatsapp',
    );
    expect(createTicket).toHaveBeenCalledTimes(1);
    const [args] = createTicket.mock.calls[0] as [
      {
        tenantId: string;
        customerId: string;
        conversationId: string;
        escalationReason: string;
        note: string;
      },
    ];
    expect(args.tenantId).toBe(TENANT_A);
    expect(args.customerId).toBe(CUSTOMER_ID);
    expect(args.conversationId).toBe(CONVERSATION_ID);
    expect(args.escalationReason).toBe('JOB_FAILURE');
    expect(args.note).toContain('wamid.1, wamid.2');
  });

  it('records one agent_runs row with status "error" and the real error message once attempts are exhausted (A8)', async () => {
    const { processor, recordRun } = makeHarness();
    const job = makeJob({ attemptsMade: 3, opts: { attempts: 3 } });

    await processor.onFailed(job, new Error('final failure'));

    expect(recordRun).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      conversationId: CONVERSATION_ID,
      ticketId: 'ticket-1',
      status: 'error',
      escalationReason: 'JOB_FAILURE',
      escalationSource: 'error_forced',
      escalationDetail: null,
      agentId: AGENT_ID,
      agentConfigVersion: 1,
      confidence: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      spans: {},
      promptVersion: null,
      errorMessage: 'final failure',
    });
  });

  it('does not record an agent_runs row while attempts remain (only once the job is truly exhausted)', async () => {
    const { processor, recordRun } = makeHarness();

    await processor.onFailed(
      makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
      new Error('transient'),
    );

    expect(recordRun).not.toHaveBeenCalled();
  });

  it('is a no-op when job is undefined (BullMQ can pass this)', async () => {
    const { processor, createTicket } = makeHarness();

    await expect(
      processor.onFailed(undefined, new Error('x')),
    ).resolves.toBeUndefined();
    expect(createTicket).not.toHaveBeenCalled();
  });

  describe('outbound delivery (T0)', () => {
    it('sends the answer back to the customer on the number it arrived on', async () => {
      const { processor, sendText } = makeHarness();

      await processor.process(makeJob());

      expect(sendText).toHaveBeenCalledWith({
        channelAccountId: 'PHONE_NUMBER_ID',
        to: '155',
        body: 'Refunds take 5 days.',
      });
    });

    it('still sends the answer when the turn escalated (the customer gets the handoff message)', async () => {
      const { processor, respond, sendText } = makeHarness();
      respond.mockResolvedValue(
        makeAgentResult({
          answer: 'Let me connect you with a human.',
          escalate: true,
          escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        }),
      );

      await processor.process(makeJob());

      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Let me connect you with a human.' }),
      );
    });

    it('escalates a delivery failure to a ticket instead of failing the job (no duplicate LLM turn on retry)', async () => {
      const { processor, sendText, createTicket } = makeHarness();
      sendText.mockRejectedValue(new Error('HTTP 401: invalid api key'));

      await expect(processor.process(makeJob())).resolves.toBeUndefined();

      expect(createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ escalationReason: 'DELIVERY_FAILURE' }),
      );
      const [{ note }] = createTicket.mock.calls[0] as [{ note: string }];
      expect(note).toContain('delivery failed');
    });

    it('does not create a SECOND ticket when an escalated turn also fails to deliver', async () => {
      const { processor, respond, sendText, createTicket } = makeHarness();
      respond.mockResolvedValue(
        makeAgentResult({
          escalate: true,
          escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        }),
      );
      sendText.mockRejectedValue(new Error('boom'));

      await processor.process(makeJob());

      expect(createTicket).toHaveBeenCalledTimes(1);
      expect(createTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        }),
      );
    });

    it('skips delivery (with a warning, not a crash) for a pre-cutover job carrying no channelAccountId', async () => {
      const { processor, sendText, createTicket, warn } = makeHarness();
      const job = makeJob();
      delete (job.data as { channelAccountId?: string }).channelAccountId;

      await expect(processor.process(job)).resolves.toBeUndefined();

      expect(sendText).not.toHaveBeenCalled();
      expect(createTicket).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('no channelAccountId'),
        'RespondPathProcessor',
      );
    });

    it('still records exactly one run when delivery fails — the run happened and cost money', async () => {
      const { processor, sendText, recordRun, recordAssistantMessage } =
        makeHarness();
      sendText.mockRejectedValue(new Error('boom'));

      await processor.process(makeJob());

      expect(recordAssistantMessage).toHaveBeenCalled();
      expect(recordRun).toHaveBeenCalledTimes(1);
    });

    // An undelivered answer used to be recorded as status='success' with a
    // null escalation_reason while a DELIVERY_FAILURE ticket sat beside it on the
    // same conversation: A9's resolution rate counted the turn as handled and
    // the escalation mix never saw it, so "the customer never got their
    // answer" was invisible to every metric that matters.
    it('records an undelivered answer as an error run with DELIVERY_FAILURE, not a success and not TOOL_FAILURE (A8/A9)', async () => {
      const { processor, sendText, recordRun } = makeHarness();
      sendText.mockRejectedValue(new Error('boom'));

      await processor.process(makeJob());

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          escalationReason: 'DELIVERY_FAILURE',
          escalationSource: 'error_forced',
          ticketId: 'ticket-1',
          errorMessage: expect.stringContaining('boom') as string,
        }),
      );
    });

    // The agent's own reason is the interesting one and must not be
    // overwritten by the delivery problem — the turn escalated for a
    // customer-facing reason first, and only then failed to deliver. A human
    // is taking over either way, which is what `escalated` records; the
    // delivery failure still has to appear somewhere, so it lands on
    // errorMessage rather than being dropped.
    it('keeps an escalated turn’s own status and escalation_reason when delivery also fails, but still records the delivery failure', async () => {
      const { processor, sendText, recordRun } = makeHarness(
        makeAgentResult({
          escalate: true,
          escalationReason: 'CUSTOMER_DISTRESS',
          escalationSource: 'agent_decision',
        }),
      );
      sendText.mockRejectedValue(new Error('boom'));

      await processor.process(makeJob());

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'escalated',
          escalationReason: 'CUSTOMER_DISTRESS',
          escalationSource: 'agent_decision',
          errorMessage: expect.stringContaining('boom') as string,
        }),
      );
    });
  });
});

describe('RespondPathProcessor human handover', () => {
  it('records the inbound message but runs no agent turn while a human holds the conversation', async () => {
    const {
      processor,
      getOrCreateConversation,
      recordInboundMessages,
      respond,
      sendText,
      recordRun,
      createTicket,
    } = makeHarness();
    getOrCreateConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '155',
      handoverState: 'human',
      handoverAt: new Date(),
      handoverUserId: 'user-1',
      rollingSummary: null,
    });

    await processor.process(makeJob());

    expect(recordInboundMessages).toHaveBeenCalled();
    // The whole point: the customer must not get an AI answer on top of the
    // human's. No turn, no send, no agent_runs row, no ticket.
    expect(respond).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
  });

  describe('customer messages during handover (ISSUE-001)', () => {
    const handedOver = (overrides: Record<string, unknown> = {}) => ({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '155',
      handoverState: 'human',
      handoverAt: new Date(),
      handoverUserId: 'user-1',
      handoverHoldingReplyAt: null,
      rollingSummary: null,
      ...overrides,
    });
    const jobWith = (text: string) =>
      makeJob({
        data: {
          tenantId: TENANT_A,
          channelAccountId: 'PHONE_NUMBER_ID',
          from: '155',
          messages: [{ providerMessageId: 'wamid.9', text }],
        },
      });

    it('on an explicit human request: ticket + one holding reply, agent stays silent', async () => {
      const h = makeHarness();
      h.getOrCreateConversation.mockResolvedValue(handedOver());

      await h.processor.process(jobWith('I want to talk with management'));

      expect(h.respond).not.toHaveBeenCalled();
      expect(h.recordRun).not.toHaveBeenCalled();
      expect(h.createTicket).toHaveBeenCalledTimes(1);
      expect(h.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_A,
          customerId: CUSTOMER_ID,
          conversationId: CONVERSATION_ID,
          escalationReason: 'EXPLICIT_USER_REQUEST',
        }),
      );
      expect(h.sendText).toHaveBeenCalledTimes(1);
      expect(h.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'A team member will reply shortly.',
        }),
      );
      expect(h.recordAssistantMessage).toHaveBeenCalledWith(
        TENANT_A,
        CONVERSATION_ID,
        'A team member will reply shortly.',
      );
      expect(h.markHandoverHoldingReplySent).toHaveBeenCalledWith(
        TENANT_A,
        CONVERSATION_ID,
        expect.any(Date),
      );
    });

    it('replies in Arabic when the customer wrote in Arabic', async () => {
      const h = makeHarness();
      h.getOrCreateConversation.mockResolvedValue(handedOver());

      await h.processor.process(jobWith('أريد التحدث مع المدير'));

      const [{ body }] = h.sendText.mock.calls[0] as [{ body: string }];
      expect(body).toMatch(/[\u0600-\u06FF]/);
    });

    it('sends no second holding reply in the same handover, but still bumps the ticket', async () => {
      const h = makeHarness();
      h.getOrCreateConversation.mockResolvedValue(
        handedOver({ handoverHoldingReplyAt: new Date() }),
      );

      await h.processor.process(jobWith('hello?? I want a human'));

      expect(h.sendText).not.toHaveBeenCalled();
      expect(h.markHandoverHoldingReplySent).not.toHaveBeenCalled();
      expect(h.createTicket).toHaveBeenCalledTimes(1);
      expect(h.respond).not.toHaveBeenCalled();
    });

    it('stays fully silent when no human is requested and a human already replied', async () => {
      const h = makeHarness();
      h.getOrCreateConversation.mockResolvedValue(handedOver());
      h.hasHumanReplySince.mockResolvedValue(true);

      await h.processor.process(jobWith('ok thanks'));

      expect(h.sendText).not.toHaveBeenCalled();
      expect(h.createTicket).not.toHaveBeenCalled();
      expect(h.respond).not.toHaveBeenCalled();
    });

    it('alerts and holds once when nobody has replied since the handover, even without an explicit request', async () => {
      const h = makeHarness();
      h.getOrCreateConversation.mockResolvedValue(handedOver());
      h.hasHumanReplySince.mockResolvedValue(false);

      await h.processor.process(jobWith('where is my order'));

      expect(h.createTicket).toHaveBeenCalledTimes(1);
      expect(h.sendText).toHaveBeenCalledTimes(1);
      expect(h.respond).not.toHaveBeenCalled();
    });

    it('does not mark the holding reply sent when the send fails, and does not throw', async () => {
      const h = makeHarness();
      h.getOrCreateConversation.mockResolvedValue(handedOver());
      h.sendText.mockRejectedValue(new Error('boom'));

      await expect(
        h.processor.process(jobWith('get me a manager')),
      ).resolves.toBeUndefined();

      expect(h.createTicket).toHaveBeenCalledTimes(1);
      expect(h.markHandoverHoldingReplySent).not.toHaveBeenCalled();
    });
  });

  it('auto-returns a stale handover and answers the message that found it', async () => {
    const { processor, getOrCreateConversation, returnToAgent, respond } =
      makeHarness();
    getOrCreateConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '155',
      handoverState: 'human',
      handoverAt: new Date(
        Date.now() - (HANDOVER_AUTO_RETURN_MINUTES + 1) * 60_000,
      ),
      handoverUserId: 'user-1',
      rollingSummary: null,
    });

    await processor.process(makeJob());

    expect(returnToAgent).toHaveBeenCalledWith(
      TENANT_A,
      CONVERSATION_ID,
      expect.any(Date),
    );
    expect(respond).toHaveBeenCalled();
  });

  it('treats a handover with no timestamp as stale rather than muting the conversation forever', async () => {
    const { processor, getOrCreateConversation, returnToAgent, respond } =
      makeHarness();
    getOrCreateConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '155',
      handoverState: 'human',
      handoverAt: null,
      handoverUserId: 'user-1',
      rollingSummary: null,
    });

    await processor.process(makeJob());

    expect(returnToAgent).toHaveBeenCalled();
    expect(respond).toHaveBeenCalled();
  });
});

describe('RespondPathProcessor outbound delivery tracking', () => {
  it('attaches the BSP message id to the stored reply so a later status callback can match it', async () => {
    const { processor, attachOutboundDelivery, sendText } = makeHarness();
    sendText.mockResolvedValue({ providerMessageId: 'wamid.out' });

    await processor.process(makeJob());

    expect(attachOutboundDelivery).toHaveBeenCalledWith(
      TENANT_A,
      ASSISTANT_MESSAGE_ID,
      'wamid.out',
    );
  });

  it('does not attach anything when the send failed — there is no id to attach', async () => {
    const { processor, attachOutboundDelivery, sendText } = makeHarness();
    sendText.mockRejectedValue(new Error('Meta 401'));

    await processor.process(makeJob());

    expect(attachOutboundDelivery).not.toHaveBeenCalled();
  });
});

describe('RespondPathProcessor business hours', () => {
  const closedSchedule = {
    // Monday only, and the test clock below lands on a Tuesday.
    businessHours: { mon: { open: '09:00', close: '17:00' } },
    timezone: 'Asia/Dhaka',
    outOfHoursResponse: 'We reply from 9am.',
  };

  function agentWith(config: Record<string, unknown>) {
    return {
      agentId: AGENT_ID,
      name: 'Default agent',
      configVersion: 7,
      resolvedBy: 'number',
      config: {
        persona: null,
        forbiddenTopics: [],
        confidenceThreshold: 0.7,
        rerankEnabled: true,
        handoverAutoReturnMinutes: 60,
        maxToolCallsPerTurn: 2,
        kbDocumentIds: [],
        businessHours: null,
        timezone: null,
        outOfHoursResponse: null,
        intakeFields: [],
        ...config,
      },
    };
  }

  // Fake timers, not a Date.now() spy: the processor asks `new Date()`,
  // which a spy on Date.now does not affect — these tests would have passed
  // only because the real clock happened to be a Tuesday evening.
  afterEach(() => jest.useRealTimers());

  /** Tuesday 18:18 in Asia/Dhaka. */
  const TUESDAY_EVENING = new Date('2026-08-18T12:18:00Z');

  it('tells the agent it is out of hours, so it stops implying a human is reading right now', async () => {
    const { processor, resolveForPhoneNumber, respond } = makeHarness();
    resolveForPhoneNumber.mockResolvedValue(agentWith(closedSchedule));
    jest.useFakeTimers({ now: TUESDAY_EVENING, doNotFake: ['nextTick'] });

    await processor.process(makeJob());

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantPolicy: expect.objectContaining({
          outOfHours: {
            openingHours: 'mon 09:00-17:00 (Asia/Dhaka)',
            response: 'We reply from 9am.',
          },
        }),
      }),
    );
  });

  it('says nothing about hours while the tenant is open', async () => {
    const { processor, resolveForPhoneNumber, respond } = makeHarness();
    resolveForPhoneNumber.mockResolvedValue(
      agentWith({
        businessHours: { tue: { open: '09:00', close: '23:00' } },
        timezone: 'Asia/Dhaka',
        outOfHoursResponse: 'We reply from 9am.',
      }),
    );
    jest.useFakeTimers({ now: TUESDAY_EVENING, doNotFake: ['nextTick'] });

    await processor.process(makeJob());

    const [input] = respond.mock.calls[0] as [
      { tenantPolicy: Record<string, unknown> },
    ];
    expect(input.tenantPolicy.outOfHours).toBeUndefined();
  });

  it('is driven by the clock, not by which day the suite happens to run on', async () => {
    const { processor, resolveForPhoneNumber, respond } = makeHarness();
    // Open Tuesdays; the fake clock is a Wednesday, so this must read closed.
    resolveForPhoneNumber.mockResolvedValue(
      agentWith({
        businessHours: { tue: { open: '09:00', close: '23:00' } },
        timezone: 'Asia/Dhaka',
        outOfHoursResponse: null,
      }),
    );
    jest.useFakeTimers({
      now: new Date('2026-08-19T12:18:00Z'),
      doNotFake: ['nextTick'],
    });

    await processor.process(makeJob());

    const [input] = respond.mock.calls[0] as [
      { tenantPolicy: Record<string, unknown> },
    ];
    expect(input.tenantPolicy.outOfHours).toBeDefined();
  });

  it('says nothing about hours for an agent with none configured', async () => {
    const { processor, respond } = makeHarness();

    await processor.process(makeJob());

    const [input] = respond.mock.calls[0] as [
      { tenantPolicy: Record<string, unknown> },
    ];
    expect(input.tenantPolicy.outOfHours).toBeUndefined();
  });
});

describe('RespondPathProcessor outbound webhooks (F11)', () => {
  const agentWithIntake = {
    agentId: AGENT_ID,
    name: 'Default agent',
    configVersion: 9,
    resolvedBy: 'number',
    config: {
      persona: null,
      forbiddenTopics: [],
      confidenceThreshold: 0.7,
      rerankEnabled: true,
      handoverAutoReturnMinutes: 60,
      maxToolCallsPerTurn: 2,
      kbDocumentIds: [],
      businessHours: null,
      timezone: null,
      outOfHoursResponse: null,
      intakeFields: [
        {
          key: 'order_number',
          label: 'Order number',
          type: 'text',
          required: true,
          scope: 'conversation',
        },
      ],
    },
  };

  it("emits the captured values to the tenant's own system", async () => {
    const {
      processor,
      resolveForPhoneNumber,
      respond,
      recordIntake,
      emitWebhook,
    } = makeHarness();
    resolveForPhoneNumber.mockResolvedValue(agentWithIntake);
    respond.mockResolvedValue(
      makeAgentResult({ intake: { order_number: 'B-7742' } }),
    );
    recordIntake.mockResolvedValue({ stored: ['order_number'], ignored: [] });

    await processor.process(makeJob());

    expect(emitWebhook).toHaveBeenCalledWith(
      TENANT_A,
      'conversation.intake_captured',
      expect.objectContaining({ intake: { order_number: 'B-7742' } }),
    );
  });

  it("emits nothing when nothing was stored — an event with no data is noise in someone else's system", async () => {
    const {
      processor,
      resolveForPhoneNumber,
      respond,
      recordIntake,
      emitWebhook,
    } = makeHarness();
    resolveForPhoneNumber.mockResolvedValue(agentWithIntake);
    respond.mockResolvedValue(
      makeAgentResult({ intake: { made_up_key: 'x' } }),
    );
    recordIntake.mockResolvedValue({ stored: [], ignored: ['made_up_key'] });

    await processor.process(makeJob());

    expect(emitWebhook).not.toHaveBeenCalled();
  });

  it('still answers the customer when queueing the webhook throws', async () => {
    const {
      processor,
      resolveForPhoneNumber,
      respond,
      recordIntake,
      emitWebhook,
      sendText,
    } = makeHarness();
    resolveForPhoneNumber.mockResolvedValue(agentWithIntake);
    respond.mockResolvedValue(
      makeAgentResult({ intake: { order_number: 'B-7742' } }),
    );
    recordIntake.mockResolvedValue({ stored: ['order_number'], ignored: [] });
    emitWebhook.mockRejectedValue(new Error('redis is down'));

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    // The reply is the product; a tenant's integration is not allowed to
    // break it.
    expect(sendText).toHaveBeenCalled();
  });
});

describe('RespondPathProcessor intent labeling (Feature 18)', () => {
  it("hands A5's decision to the label write in the same respond-path cycle, keyed on the resolved customer", async () => {
    const { processor, applyAgentSignal, respond } = makeHarness();
    respond.mockResolvedValue(
      makeAgentResult({
        escalate: true,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        escalationSource: 'agent_decision',
      }),
    );

    await processor.process(makeJob());

    // Exit criterion: no batch job, no lag — the write happens inline, on the
    // turn, with the signal A5 already computed and nothing recomputed.
    expect(applyAgentSignal).toHaveBeenCalledWith(TENANT_A, CUSTOMER_ID, {
      escalate: true,
      escalationReason: 'EXPLICIT_USER_REQUEST',
      escalationSource: 'agent_decision',
    });
  });

  it('labels a clean, fully answered turn too — not only escalations', async () => {
    const { processor, applyAgentSignal } = makeHarness();

    await processor.process(makeJob());

    expect(applyAgentSignal).toHaveBeenCalledWith(TENANT_A, CUSTOMER_ID, {
      escalate: false,
      escalationReason: null,
      escalationSource: null,
    });
  });

  it('passes error_forced through untouched and lets the derivation drop it (D13)', async () => {
    // The processor must not second-guess the source here: one place decides
    // what an error_forced signal means for a label, and it is the
    // derivation, not this call site.
    const { processor, applyAgentSignal, checkEntitlement } = makeHarness();
    checkEntitlement.mockResolvedValue({
      allowed: true,
      blockReason: null,
      hasEnforceablePlan: true,
      overMessageLimit: true,
      overSpendCap: false,
      usage: null,
    });

    await processor.process(makeJob());

    expect(applyAgentSignal).toHaveBeenCalledWith(TENANT_A, CUSTOMER_ID, {
      escalate: true,
      escalationReason: 'USAGE_CAP_EXCEEDED',
      escalationSource: 'error_forced',
    });
  });

  it('does not label a turn a human has taken over — the agent never ran, so there is no A5 decision', async () => {
    const { processor, applyAgentSignal, getOrCreateConversation } =
      makeHarness();
    getOrCreateConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '155',
      handoverState: 'human',
      handoverAt: new Date(),
      handoverUserId: 'user-1',
      rollingSummary: null,
    });

    await processor.process(makeJob());

    expect(applyAgentSignal).not.toHaveBeenCalled();
  });
});

// F17/A11/A12: the respond path fetches an attachment's bytes and hands them to
// the agent. Whatever happens, the turn ends in a recorded message and either an
// answer or a ticket — never silence.
describe('RespondPathProcessor.process() — media turns (F17)', () => {
  const MEDIA_JOB = {
    id: 'job-media',
    data: {
      tenantId: TENANT_A,
      channelAccountId: 'PHONE_NUMBER_ID',
      from: '155',
      messages: [
        {
          providerMessageId: 'wamid.IMG',
          text: 'how much is this?',
          media: {
            messageId: 'message-9',
            kind: 'image' as const,
            mimeType: 'image/jpeg',
            storageKey: 'tenant-a/photo.jpg',
          },
        },
      ],
    },
    opts: { attempts: 3 },
    attemptsMade: 1,
  } as unknown as Job<CoalescedRespondJobData>;

  it('loads the stored bytes and passes them to AgentRuntime as turn media', async () => {
    const { processor, respond, storageDownload } = makeHarness();

    await processor.process(MEDIA_JOB);

    expect(storageDownload).toHaveBeenCalledWith('tenant-a/photo.jpg');
    const [turn] = respond.mock.calls[0] as [
      {
        media: Array<{
          kind: string;
          mimeType: string;
          bytes: Buffer;
          messageId: string;
        }>;
      },
    ];
    expect(turn.media).toHaveLength(1);
    expect(turn.media[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      messageId: 'message-9',
    });
    expect(Buffer.isBuffer(turn.media[0].bytes)).toBe(true);
  });

  it('escalates as UNSUPPORTED_MEDIA — without calling the agent — when the bytes cannot be read back', async () => {
    const { processor, respond, storageDownload, createTicket, recordRun } =
      makeHarness();
    storageDownload.mockRejectedValue(new Error('object missing'));

    await processor.process(MEDIA_JOB);

    expect(respond).not.toHaveBeenCalled();
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
    // A8: still exactly one agent_runs row, on the error path as on any other.
    expect(recordRun).toHaveBeenCalledTimes(1);
    const [run] = recordRun.mock.calls[0] as [Record<string, unknown>];
    expect(run).toMatchObject({
      status: 'escalated',
      escalationReason: 'UNSUPPORTED_MEDIA',
      escalationSource: 'error_forced',
      escalationDetail: 'media_unreadable',
    });
  });

  it('still records the customer message and replies when the media is unreadable', async () => {
    const { processor, storageDownload, recordInboundMessages, sendText } =
      makeHarness();
    storageDownload.mockRejectedValue(new Error('object missing'));

    await processor.process(MEDIA_JOB);

    expect(recordInboundMessages).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalled();
  });
});
