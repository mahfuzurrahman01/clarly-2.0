import { AgentConfigModule } from '../agent-config/agent-config.module';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { LlmModule } from '../llm/llm.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TicketModule } from '../ticket/ticket.module';
import { AUTO_CLOSE_SWEEP_QUEUE } from '../outcomes/auto-close-sweep.queue';
import { KB_INGEST_QUEUE } from '../knowledge-base/kb-ingest.queue';
import { RESPOND_PATH_QUEUE } from '../queue/queue.providers';
import { SUMMARIZE_QUEUE } from '../conversation/summarize.queue';
import { TRANSCRIPT_PURGE_QUEUE } from '../retention/transcript-purge.queue';
import { AlertDebouncer } from './alert-debouncer';
import { LatencyBudgetAlertEventsService } from './latency-budget-alert-events.service';
import { LatencyBudgetCheckProcessor } from './latency-budget-check.processor';
import { LATENCY_BUDGET_CHECK_QUEUE } from './latency-budget-check.queue';
import { LatencyBudgetCheckSchedulerService } from './latency-budget-check-scheduler.service';
import { LatencyBudgetCheckService } from './latency-budget-check.service';
import { PlatformHealthAlertEventsService } from './platform-health-alert-events.service';
import { PlatformHealthCheckProcessor } from './platform-health-check.processor';
import { PLATFORM_HEALTH_CHECK_QUEUE } from './platform-health-check.queue';
import { PlatformHealthCheckSchedulerService } from './platform-health-check-scheduler.service';
import { PlatformHealthCheckService } from './platform-health-check.service';
import { StuckTicketAlertEventsService } from './stuck-ticket-alert-events.service';
import { StuckTicketCheckProcessor } from './stuck-ticket-check.processor';
import { STUCK_TICKET_CHECK_QUEUE } from './stuck-ticket-check.queue';
import { StuckTicketCheckSchedulerService } from './stuck-ticket-check-scheduler.service';
import { StuckTicketCheckService } from './stuck-ticket-check.service';
import { ToolScopeViolationAlertEventsService } from './tool-scope-violation-alert-events.service';
import { ToolScopeViolationCheckProcessor } from './tool-scope-violation-check.processor';
import { TOOL_SCOPE_VIOLATION_CHECK_QUEUE } from './tool-scope-violation-check.queue';
import { ToolScopeViolationCheckSchedulerService } from './tool-scope-violation-check-scheduler.service';
import { ToolScopeViolationCheckService } from './tool-scope-violation-check.service';

export * from './stuck-ticket-alert.dto';
export * from './latency-budget-alert.dto';
export * from './platform-health-alert.dto';
export * from './tool-scope-violation-alert.dto';
export { StuckTicketAlertEventsService } from './stuck-ticket-alert-events.service';
export { StuckTicketCheckService } from './stuck-ticket-check.service';
export { LatencyBudgetAlertEventsService } from './latency-budget-alert-events.service';
export { LatencyBudgetCheckService } from './latency-budget-check.service';
export { PlatformHealthAlertEventsService } from './platform-health-alert-events.service';
export { PlatformHealthCheckService } from './platform-health-check.service';
export { ToolScopeViolationAlertEventsService } from './tool-scope-violation-alert-events.service';
export { ToolScopeViolationCheckService } from './tool-scope-violation-check.service';
export { AlertDebouncer } from './alert-debouncer';

// Product shell: stuck-ticket, latency-budget, platform-health,
// tool-scope-violation sweeps (T4/T9/T18).
//
// THIS PASS (T18 "Internal Alerting Completeness", Sentry explicitly
// deferred per user instruction): two more BullMQ repeatable jobs.
// `PlatformHealthCheckService` consolidates 4 platform-level (non-tenant-
// scoped) conditions — circuit breaker open, queue/DLQ depth, tenant
// count threshold, dependency (Postgres/Redis) unreachable — into ONE
// pipeline sharing one cadence, a deliberate deviation from "one alert
// type = one pipeline" justified by all 4 being fast, cheap "is the
// platform itself healthy" checks that don't need independent schedules.
// `ToolScopeViolationCheckService` stays a SEPARATE, per-tenant pipeline
// (mirrors StuckTicketCheckService exactly) since it's tenant-scoped,
// unlike the other four. `AlertDebouncer` (shared, single-instance-only,
// in-memory edge-detection) is new this pass — none of the prior checks
// needed it since they re-evaluate a naturally bounded alert set fresh
// each sweep, but these sustained binary/threshold conditions would
// otherwise re-fire every cycle while still active.
@Module({
  imports: [
    // Business hours live on the published agent: a ticket is only stuck
    // during minutes someone could have claimed it.
    AgentConfigModule,
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    QueueModule,
    OnboardingModule,
    TicketModule,
    LlmModule,
    BullModule.registerQueue({
      name: STUCK_TICKET_CHECK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: LATENCY_BUDGET_CHECK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: PLATFORM_HEALTH_CHECK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: TOOL_SCOPE_VIOLATION_CHECK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    // Read-only cross-module queue introspection for the queue-depth
    // check (Queue.getFailedCount()) — these 5 queues are owned/worked
    // elsewhere (RetentionModule, OutcomesModule, KnowledgeBaseModule,
    // QueueModule, ConversationModule); registering the same queue name
    // again here creates a second client instance against the same
    // Redis-backed queue, safe for read-only calls since this module
    // never adds jobs to them.
    BullModule.registerQueue({ name: TRANSCRIPT_PURGE_QUEUE }),
    BullModule.registerQueue({ name: AUTO_CLOSE_SWEEP_QUEUE }),
    BullModule.registerQueue({ name: KB_INGEST_QUEUE }),
    BullModule.registerQueue({ name: RESPOND_PATH_QUEUE }),
    BullModule.registerQueue({ name: SUMMARIZE_QUEUE }),
  ],
  controllers: [],
  providers: [
    AlertDebouncer,
    StuckTicketAlertEventsService,
    StuckTicketCheckService,
    StuckTicketCheckProcessor,
    StuckTicketCheckSchedulerService,
    LatencyBudgetAlertEventsService,
    LatencyBudgetCheckService,
    LatencyBudgetCheckProcessor,
    LatencyBudgetCheckSchedulerService,
    PlatformHealthAlertEventsService,
    PlatformHealthCheckService,
    PlatformHealthCheckProcessor,
    PlatformHealthCheckSchedulerService,
    ToolScopeViolationAlertEventsService,
    ToolScopeViolationCheckService,
    ToolScopeViolationCheckProcessor,
    ToolScopeViolationCheckSchedulerService,
  ],
  exports: [
    StuckTicketAlertEventsService,
    StuckTicketCheckService,
    LatencyBudgetAlertEventsService,
    LatencyBudgetCheckService,
    PlatformHealthAlertEventsService,
    PlatformHealthCheckService,
    ToolScopeViolationAlertEventsService,
    ToolScopeViolationCheckService,
  ],
})
export class AlertingModule {}
