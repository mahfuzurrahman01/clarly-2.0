// Product shell (AgentConfigModule, F9): let a tenant talk to their own agent
// before pointing customers at it.
//
// Without this, a tenant's first test of their own configuration is a real
// customer. That is the single thing standing between "you can configure an
// agent" and "you can safely configure an agent", and it is why the free-text
// escape hatch in docs/decisions/F9-agent-configuration.md is gated on this
// existing.
//
// The run is REAL — the same AgentRuntime, the same retrieval, the same
// grounding and escalation checks — with exactly two things removed:
//   - nothing is sent to WhatsApp (no BspAdapter here at all), and
//   - nothing is recorded. No conversation, no messages, no ticket, and
//     deliberately no `agent_runs` row: a tenant testing a draft twenty times
//     must not move the resolution rate and escalation mix they are judged
//     on. A sandbox turn that showed up in metrics would make the metrics
//     lie about real customer traffic.
import { Injectable, NotFoundException } from '@nestjs/common';
import { AgentRuntime } from '../agent/agent-runtime';
import type { AgentTurnResult } from '../agent/agent-turn.dto';
import { AgentManagementService } from './agent-management.service';
import { describeNextOpening, isOpenAt } from './business-hours';

export interface SandboxTurnResult {
  answer: string;
  citedChunkIds: string[];
  confidence: number;
  escalate: boolean;
  escalationReason: string | null;
  /** Which configuration answered — the draft when there is one, since testing what you just edited is the point. */
  testedVersion: 'draft' | 'published';
  latencyMs: number;
}

@Injectable()
export class AgentSandboxService {
  constructor(
    private readonly agentManagement: AgentManagementService,
    private readonly agentRuntime: AgentRuntime,
  ) {}

  async run(
    tenantId: string,
    agentId: string,
    message: string,
  ): Promise<SandboxTurnResult> {
    const agent = await this.agentManagement.get(tenantId, agentId);
    const scope = await this.agentManagement.knowledgeScope(tenantId, agentId);
    if (!agent.config) {
      throw new NotFoundException(
        `Agent ${agentId} has no configuration to test yet`,
      );
    }

    // `agent.config` is already the draft when one exists (see
    // AgentManagementService.toRecord) — a sandbox that tested the published
    // version while the tenant was editing a draft would answer a question
    // nobody asked.
    const result: AgentTurnResult = await this.agentRuntime.respond({
      tenantId,
      // A sandbox turn is always the first turn: no history to carry, and
      // inventing one would test a conversation the tenant never had.
      conversationSummary: null,
      recentMessages: [],
      currentMessage: message,
      tenantPolicy: {
        tonePersonaOverride: agent.config.persona,
        forbiddenTopics: agent.config.forbiddenTopics,
        confidenceThreshold: agent.config.confidenceThreshold,
        rerankEnabled: agent.config.rerankEnabled,
        // The sandbox reflects whether the tenant is open RIGHT NOW, same as
        // a live turn — otherwise "what does it say out of hours" is the one
        // question the sandbox cannot answer.
        ...(isOpenAt(
          agent.config.businessHours,
          agent.config.timezone,
          new Date(),
        )
          ? {}
          : {
              outOfHours: {
                openingHours: describeNextOpening(
                  agent.config.businessHours,
                  agent.config.timezone,
                ),
                response: agent.config.outOfHoursResponse,
              },
            }),
      },
      // The same scope the live agent runs with. A sandbox that could read
      // documents the real agent cannot would answer questions the customer
      // will not get an answer to.
      kbDocumentIds: scope.documents
        .filter((document) => document.selected)
        .map((document) => document.id),
    });

    return {
      answer: result.answer,
      citedChunkIds: result.citedChunkIds,
      confidence: result.confidence,
      escalate: result.escalate,
      escalationReason: result.escalationReason ?? null,
      testedVersion: agent.hasUnpublishedChanges ? 'draft' : 'published',
      latencyMs: result.telemetry.latencyMs,
    };
  }
}
