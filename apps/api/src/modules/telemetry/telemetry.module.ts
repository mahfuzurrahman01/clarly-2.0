import { Module } from '@nestjs/common';
import { CoreModule } from '../core';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AgentRunService } from './agent-run.service';

export * from './agent-run.dto';
export { AgentRunService } from './agent-run.service';
export { estimateCostUsd } from './llm-cost';

// Product shell (Feature 7, A8/T9): agent_runs persistence + cost
// accounting. Deliberately separate from AgentModule (AI-owned, produces
// the raw telemetry on AgentTurnResult but never persists it or knows
// about vendor pricing — see agent.module.ts's own comment) and from
// MetricsModule (Feature 5's resolution-rate/escalation-breakdown API,
// which reads `tickets`/`conversations` directly, not `agent_runs` — that
// wiring is Feature 7's own later A9-hardening slice, not this one).
// RespondPathProcessor (WebhookModule) is the sole caller.
@Module({
  imports: [CoreModule, TenantContextModule],
  controllers: [],
  providers: [AgentRunService],
  exports: [AgentRunService],
})
export class TelemetryModule {}
