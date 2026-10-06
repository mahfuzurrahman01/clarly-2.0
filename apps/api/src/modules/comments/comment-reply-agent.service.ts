// Gulf T8 (D11 tier 3): the full agent, for purchase/question comments only.
//
// The same AgentRuntime, the same agent configuration (resolved for the page
// or IG account the comment arrived on), the same retrieval and grounding as
// a DM turn. What it produces is the PRIVATE reply's text: the answer goes to
// the commenter's inbox, never into the public thread.
//
// Every run writes one `agent_runs` row (conversation null: no conversation
// exists until the customer answers, D15b). That row is what makes a comment
// answer count against the tenant's monthly usage like any other agent turn.
import { Injectable } from '@nestjs/common';
import { AgentRuntime } from '../agent/agent-runtime';
import { AgentConfigService } from '../agent-config/agent-config.service';
import { toAgentTenantPolicy } from '../agent-config/agent-turn-policy';
import { TenantPolicyService } from '../onboarding/tenant-policy.service';
import { AgentRunService } from '../telemetry/agent-run.service';

export interface CommentReplyInput {
  tenantId: string;
  channelAccountId: string;
  text: string;
}

export type CommentReplyDraft =
  | { kind: 'answer'; text: string }
  /** The turn was forced to escalate by our own machinery (LLM error, deadline): there is nothing worth sending. */
  | { kind: 'unavailable'; reason: `agent_${string}` };

@Injectable()
export class CommentReplyAgent {
  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly tenantPolicy: TenantPolicyService,
    private readonly runtime: AgentRuntime,
    private readonly agentRuns: AgentRunService,
  ) {}

  async draft(input: CommentReplyInput): Promise<CommentReplyDraft> {
    const agent = await this.agentConfig.resolveForPhoneNumber(
      input.tenantId,
      input.channelAccountId,
    );
    const policy = toAgentTenantPolicy(
      agent,
      agent ? null : await this.tenantPolicy.getForTenant(input.tenantId),
    );
    if (!policy) {
      // Same rule as the respond path: a tenant with no configuration is a
      // setup error to surface (the job fails and is retried/logged), not
      // something to paper over with guessed defaults.
      throw new Error(
        `No published agent and no tenant_policy row for tenant ${input.tenantId} — cannot answer a comment without configuration.`,
      );
    }

    const result = await this.runtime.respond({
      tenantId: input.tenantId,
      // A comment is always a first contact: there is no conversation yet.
      conversationSummary: null,
      // ...and therefore no conversation, customer or respond-path turn to
      // scope a tool call to. Passed explicitly as null rather than omitted,
      // so this stays a deliberate statement: any customer-scoped tool
      // reached from a comment turn must fail closed, never answer unscoped.
      conversationId: null,
      customerId: null,
      turnId: null,
      recentMessages: [],
      currentMessage: input.text,
      tenantPolicy: policy,
      kbDocumentIds: agent?.config.kbDocumentIds ?? [],
    });

    await this.agentRuns.recordRun({
      tenantId: input.tenantId,
      conversationId: null,
      ticketId: null,
      agentId: agent?.agentId ?? null,
      agentConfigVersion: agent?.configVersion ?? null,
      status: result.escalate ? 'escalated' : 'success',
      escalationReason: result.escalationReason,
      escalationSource: result.escalationSource,
      escalationDetail: result.escalationDetail ?? null,
      confidence: result.confidence,
      inputTokens: result.telemetry.inputTokens,
      outputTokens: result.telemetry.outputTokens,
      latencyMs: result.telemetry.latencyMs,
      spans: result.telemetry.spans,
      promptVersion: result.promptVersion || null,
      errorMessage: null,
    });

    // An `agent_decision` escalation (low confidence, KB gap, the customer
    // asking for a person) still produces customer-facing text that invites
    // them to write back, which is exactly what opens a real conversation
    // with a ticket behind it. An `error_forced` one is our outage talking.
    if (result.escalate && result.escalationSource === 'error_forced') {
      return {
        kind: 'unavailable',
        reason: `agent_${(result.escalationReason ?? 'error').toLowerCase()}`,
      };
    }
    return { kind: 'answer', text: result.answer };
  }
}
