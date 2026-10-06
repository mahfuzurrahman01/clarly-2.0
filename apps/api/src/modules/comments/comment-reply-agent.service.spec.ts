import type { AgentRuntime } from '../agent/agent-runtime';
import type { AgentTurnResult } from '../agent/agent-turn.dto';
import type { AgentConfigService } from '../agent-config/agent-config.service';
import type { TenantPolicyService } from '../onboarding/tenant-policy.service';
import type { AgentRunService } from '../telemetry/agent-run.service';
import { CommentReplyAgent } from './comment-reply-agent.service';

function turn(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return {
    answer: 'The blue abaya is 250 SAR, delivered in 2 days.',
    citedChunkIds: ['c1'],
    confidence: 0.9,
    escalate: false,
    escalationReason: null,
    escalationSource: null,
    isHallucination: false,
    promptVersion: 'v7',
    telemetry: {
      inputTokens: 500,
      outputTokens: 40,
      latencyMs: 900,
      spans: {},
    },
    ...overrides,
  };
}

describe('CommentReplyAgent', () => {
  const agent = {
    agentId: 'agent-1',
    configVersion: 3,
    config: {
      persona: 'warm',
      forbiddenTopics: [],
      confidenceThreshold: 0.6,
      rerankEnabled: false,
      kbDocumentIds: ['doc-1'],
    },
  };

  function build(options: {
    resolved?: unknown;
    tenantPolicy?: unknown;
    result?: AgentTurnResult;
  }) {
    const respond = jest.fn().mockResolvedValue(options.result ?? turn());
    const recordRun = jest.fn().mockResolvedValue(undefined);
    const service = new CommentReplyAgent(
      {
        resolveForPhoneNumber: jest
          .fn()
          .mockResolvedValue(options.resolved ?? null),
      } as unknown as AgentConfigService,
      {
        getForTenant: jest.fn().mockResolvedValue(options.tenantPolicy ?? null),
      } as unknown as TenantPolicyService,
      { respond } as unknown as AgentRuntime,
      { recordRun } as unknown as AgentRunService,
    );
    return { service, respond, recordRun };
  }

  const input = { tenantId: 't1', channelAccountId: 'page-1', text: 'price?' };

  it('runs the agent bound to the page as a first-contact turn and returns its answer', async () => {
    const { service, respond } = build({ resolved: agent });

    await expect(service.draft(input)).resolves.toEqual({
      kind: 'answer',
      text: 'The blue abaya is 250 SAR, delivered in 2 days.',
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        conversationSummary: null,
        recentMessages: [],
        currentMessage: 'price?',
        kbDocumentIds: ['doc-1'],
        // F25 D6.1 / F26 D4: a comment turn has no conversation, customer or
        // respond-path turn — passed as explicit nulls so a customer-scoped
        // tool reached from here fails closed instead of answering unscoped.
        conversationId: null,
        customerId: null,
        turnId: null,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantPolicy: expect.objectContaining({
          tonePersonaOverride: 'warm',
        }) as unknown,
      }),
    );
  });

  it('records one agent_runs row with no conversation, so it counts against usage', async () => {
    const { service, recordRun } = build({ resolved: agent });
    await service.draft(input);
    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        conversationId: null,
        agentId: 'agent-1',
        agentConfigVersion: 3,
        status: 'success',
        inputTokens: 500,
        outputTokens: 40,
        promptVersion: 'v7',
      }),
    );
  });

  it('falls back to tenant_policy when no agent resolves, and fails loudly with neither', async () => {
    const fallback = build({
      tenantPolicy: {
        tonePersonaOverride: null,
        forbiddenTopics: [],
        confidenceThreshold: 0.5,
        rerankEnabled: false,
      },
    });
    await expect(fallback.service.draft(input)).resolves.toMatchObject({
      kind: 'answer',
    });

    const none = build({});
    await expect(none.service.draft(input)).rejects.toThrow(
      /No published agent/,
    );
    expect(none.respond).not.toHaveBeenCalled();
  });

  it('still sends an agent-decided escalation (it invites the customer to write back)', async () => {
    const { service, recordRun } = build({
      resolved: agent,
      result: turn({
        answer: 'Let me get a team member to confirm the price for you.',
        escalate: true,
        escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        escalationSource: 'agent_decision',
      }),
    });
    await expect(service.draft(input)).resolves.toMatchObject({
      kind: 'answer',
    });
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'escalated' }),
    );
  });

  it('sends nothing when our own machinery forced the escalation', async () => {
    const { service } = build({
      resolved: agent,
      result: turn({
        escalate: true,
        escalationReason: 'LLM_ERROR',
        escalationSource: 'error_forced',
      }),
    });
    await expect(service.draft(input)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'agent_llm_error',
    });
  });
});
