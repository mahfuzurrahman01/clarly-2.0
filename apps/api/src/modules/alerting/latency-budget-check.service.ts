// Product shell (AlertingModule, T9): "Instrument and enforce p95 <5s on
// the agent respond path." Reuses A8's `agent_runs.latency_ms` (Feature
// 7 Slice 1) rather than a second timing mechanism — this sweep is purely
// a read + aggregate over data AgentRunService already writes.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppConfigService,
  AppLoggerService,
  sweepTenantsWithBoundedConcurrency,
} from '../core';
import { agentRuns, tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { LatencyBudgetAlertEventsService } from './latency-budget-alert-events.service';
import type { LatencyBudgetAlert } from './latency-budget-alert.dto';

/** Below this sample size, a single slow request can swing the p95 wildly — skip rather than fire a noisy, statistically meaningless alert. */
const MIN_SAMPLE_SIZE = 10;

@Injectable()
export class LatencyBudgetCheckService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly alertEvents: LatencyBudgetAlertEventsService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Bounded concurrency, one tenant's failure never dropping the rest — see
   * sweep-tenants.ts's own doc comment for why the previous bare
   * `Promise.all(tenantRows.map(...))` here was the actual cause of this
   * sweep landing in the BullMQ failed set as tenant count grew.
   */
  async checkAllTenants(): Promise<LatencyBudgetAlert[]> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    const results = await sweepTenantsWithBoundedConcurrency(
      tenantRows.map((tenant) => tenant.id),
      (tenantId) => this.checkTenant(tenantId),
      { logger: this.logger, sweepName: 'latency-budget-check' },
    );

    return results
      .map((result) => result.value)
      .filter((alert): alert is LatencyBudgetAlert => alert !== null);
  }

  private async checkTenant(
    tenantId: string,
  ): Promise<LatencyBudgetAlert | null> {
    const windowMinutes = this.config.latencyCheckWindowMinutes;
    const budgetMs = this.config.latencyP95BudgetMs;

    // `status != 'error'` — T11's exhausted-retry path always records
    // latencyMs: 0 (no real timing data was ever captured, see
    // RespondPathProcessor.onFailed()'s own comment), which would
    // artificially drag the computed p95 down, not up. Only turns that
    // actually ran the loop to completion (success or escalated) reflect
    // real respond-path performance.
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            p95: sql<
              number | null
            >`percentile_cont(0.95) within group (order by ${agentRuns.latencyMs})`,
            sampleSize: sql<number>`count(*)::int`,
          })
          .from(agentRuns)
          .where(
            sql`${agentRuns.status} != 'error' and ${agentRuns.createdAt} > now() - (${windowMinutes} || ' minutes')::interval`,
          ),
      tenantId,
    );

    if (!row || row.p95 === null || row.sampleSize < MIN_SAMPLE_SIZE) {
      return null;
    }

    const p95LatencyMs = Math.round(row.p95);
    if (p95LatencyMs <= budgetMs) return null;

    const alert: LatencyBudgetAlert = {
      tenantId,
      p95LatencyMs,
      budgetMs,
      windowMinutes,
      sampleSize: row.sampleSize,
    };
    this.alertEvents.fire(alert);
    return alert;
  }
}
