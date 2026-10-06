import { NotFoundException } from '@nestjs/common';
import type { AgentRuntime } from '../agent/agent-runtime';
import type { AgentTurnResult } from '../agent/agent-turn.dto';
import type { AgentManagementService } from './agent-management.service';
import type { AgentRecord } from './agent-config.dto.zod';
import { AgentSandboxService } from './agent-sandbox.service';

const TENANT_A = 'tenant-a';
const AGENT_ID = 'agent-1';

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: AGENT_ID,
    name: 'Default agent',
    status: 'published',
    whatsappNumberId: null,
    publishedVersion: 3,
    hasUnpublishedChanges: false,
    config: {
      roleDescription: null,
      persona: 'Warm and brief.',
      tone: 'friendly',
      languages: [],
      greeting: null,
      outOfScopeResponse: null,
      forbiddenTopics: ['legal advice'],
      businessHours: null,
      timezone: null,
      outOfHoursResponse: null,
      escalationTriggers: [],
      confidenceThreshold: 0.42,
      rerankEnabled: false,
      stuckTicketThresholdMinutes: 15,
      handoverAutoReturnMinutes: 60,
      maxToolCallsPerTurn: 2,
    },
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as unknown as AgentRecord;
}

function turnResult(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return {
    answer: 'Delivery takes 3 days.',
    citedChunkIds: ['c1'],
    confidence: 0.9,
    escalate: false,
    escalationReason: null,
    escalationSource: null,
    isHallucination: false,
    promptVersion: 'v11',
    telemetry: { inputTokens: 10, outputTokens: 5, latencyMs: 1234, spans: {} },
    ...overrides,
  };
}

function makeService(
  record: AgentRecord = agentRecord(),
  documents: { id: string; filename: string; selected: boolean }[] = [],
) {
  const get = jest.fn().mockResolvedValue(record);
  const knowledgeScope = jest.fn().mockResolvedValue({
    scopedToAll: documents.every((document) => !document.selected),
    documents,
  });
  const respond = jest.fn().mockResolvedValue(turnResult());

  return {
    service: new AgentSandboxService(
      { get, knowledgeScope } as unknown as AgentManagementService,
      { respond } as unknown as AgentRuntime,
    ),
    get,
    knowledgeScope,
    respond,
  };
}

describe('AgentSandboxService.run()', () => {
  it("runs a real turn with the agent's configuration and no conversation history", async () => {
    const { service, respond } = makeService();

    const result = await service.run(
      TENANT_A,
      AGENT_ID,
      'How long is delivery?',
    );

    expect(respond).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      conversationSummary: null,
      recentMessages: [],
      currentMessage: 'How long is delivery?',
      tenantPolicy: {
        tonePersonaOverride: 'Warm and brief.',
        forbiddenTopics: ['legal advice'],
        confidenceThreshold: 0.42,
        rerankEnabled: false,
      },
      kbDocumentIds: [],
    });
    expect(result).toMatchObject({
      answer: 'Delivery takes 3 days.',
      citedChunkIds: ['c1'],
      confidence: 0.9,
      escalate: false,
      latencyMs: 1234,
    });
  });

  it('reports that it tested the draft when one exists — testing what you just edited is the point', async () => {
    const { service } = makeService(
      agentRecord({ hasUnpublishedChanges: true }),
    );

    await expect(
      service.run(TENANT_A, AGENT_ID, 'hello'),
    ).resolves.toMatchObject({ testedVersion: 'draft' });
  });

  it('surfaces an escalation instead of hiding it — a draft that escalates everything is exactly what a tenant needs to see before publishing', async () => {
    const { service, respond } = makeService();
    respond.mockResolvedValue(
      turnResult({
        escalate: true,
        escalationReason: 'KB_NOT_INDEXED',
        citedChunkIds: [],
        confidence: 0,
      }),
    );

    await expect(
      service.run(TENANT_A, AGENT_ID, 'do you ship to Mars?'),
    ).resolves.toMatchObject({
      escalate: true,
      escalationReason: 'KB_NOT_INDEXED',
      citedChunkIds: [],
    });
  });

  it('404s for an agent with no configuration at all rather than running a turn on defaults', async () => {
    const { service, respond } = makeService(agentRecord({ config: null }));

    await expect(
      service.run(TENANT_A, AGENT_ID, 'hello'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(respond).not.toHaveBeenCalled();
  });

  it('runs against the same document scope as the live agent, so a test cannot read what the real agent cannot', async () => {
    const { service, respond } = makeService(agentRecord(), [
      { id: 'doc-1', filename: 'refunds.pdf', selected: true },
      { id: 'doc-2', filename: 'internal-pricing.pdf', selected: false },
    ]);

    await service.run(TENANT_A, AGENT_ID, 'refund policy?');

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ kbDocumentIds: ['doc-1'] }),
    );
  });
});
