// TelemetryModule (Feature 7, A8): "every respond path writes exactly one
// agent_runs row, including escalation and error paths" — this is the one
// write path for that table. Cost accounting (T9/A8's backend half) lives
// here, not in AgentModule: AgentRuntime (AI-owned) only ever reports raw
// token counts, never a dollar figure, keeping vendor pricing entirely out
// of the loop's own concerns — a pricing change or provider swap never
// touches agent-runtime.ts.
import { Injectable } from '@nestjs/common';
import { AppConfigService, AppLoggerService } from '../core';
import { agentRuns } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { RecordAgentRunInput } from './agent-run.dto';
import { estimateCostUsd, isPricedModel } from './llm-cost';

@Injectable()
export class AgentRunService {
  /** Models already reported as unpriced — one warning per model per process, not one per turn. */
  private readonly unpricedModelsReported = new Set<string>();

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  async recordRun(input: RecordAgentRunInput): Promise<void> {
    const model = this.config.llmModel;
    // A8's cost accounting silently dies whenever LLM_MODEL moves ahead of
    // llm-cost.ts's pricing table (as it already has once, Gemini -> Qwen):
    // every row gets cost_usd = 0, which reads as "this run was free" rather
    // than "we have no price for this model". The zero is still written —
    // fabricating a rate would be worse — but it stops being silent.
    if (!isPricedModel(model) && !this.unpricedModelsReported.has(model)) {
      this.unpricedModelsReported.add(model);
      this.logger.warn(
        `no pricing entry for LLM_MODEL="${model}" — agent_runs.cost_usd will be written as 0 for every run on this model. Add it to llm-cost.ts's PRICING table (A8 cost accounting).`,
        'AgentRunService',
      );
    }

    const costUsd = estimateCostUsd(
      model,
      input.inputTokens,
      input.outputTokens,
    );

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx.insert(agentRuns).values({
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          ticketId: input.ticketId,
          status: input.status,
          escalationReason: input.escalationReason,
          escalationSource: input.escalationSource,
          escalationDetail: input.escalationDetail,
          agentId: input.agentId,
          agentConfigVersion: input.agentConfigVersion,
          confidence: input.confidence,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costUsd,
          latencyMs: input.latencyMs,
          spans: input.spans,
          promptVersion: input.promptVersion,
          errorMessage: input.errorMessage,
        }),
      input.tenantId,
    );
  }
}
