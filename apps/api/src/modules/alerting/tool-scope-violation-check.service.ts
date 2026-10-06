// Product shell (AlertingModule, T18): "a live cross-tenant attack
// probe" sweep. Pure read+aggregate over `agent_runs.escalation_reason =
// 'TOOL_SCOPE_VIOLATION'` (ToolExecutionService.authorize() ->
// AgentRuntime.handleToolRoundTrip() -> RespondPathProcessor already
// persists this, see agent-runtime.ts) — no second instrumentation
// point, same principle as LatencyBudgetCheckService reusing
// agent_runs.latency_ms. Debounced per-tenant so a sustained probe
// doesn't re-fire every sweep while still within the rolling window.
//
// Launch-integration fix (2026-09-17): this sweep used to fan out over every
// tenant with a bare, unbounded `Promise.all(tenantRows.map(...))` — the
// same bug already fixed in StuckTicketCheckService/LatencyBudgetCheckService/
// AutoCloseSweepService (see sweep-tenants.ts's doc comment for the full
// root-cause writeup). One tenant's connection-acquisition timeout used to
// fail the whole batch; now it's bounded concurrency with per-tenant error
// isolation via sweepTenantsWithBoundedConcurrency().
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
import { AlertDebouncer } from './alert-debouncer';
import { ToolScopeViolationAlertEventsService } from './tool-scope-violation-alert-events.service';
import type { ToolScopeViolationAlert } from './tool-scope-violation-alert.dto';

const debounceKeyForTenant = (tenantId: string): string =>
  `tool-scope-violation:${tenantId}`;

@Injectable()
export class ToolScopeViolationCheckService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly debouncer: AlertDebouncer,
    private readonly alertEvents: ToolScopeViolationAlertEventsService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  async checkAllTenants(): Promise<ToolScopeViolationAlert[]> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    const results = await sweepTenantsWithBoundedConcurrency(
      tenantRows.map((tenant) => tenant.id),
      (tenantId) => this.checkTenant(tenantId),
      { logger: this.logger, sweepName: 'tool-scope-violation-check' },
    );

    return results
      .map((result) => result.value)
      .filter((alert): alert is ToolScopeViolationAlert => alert !== null);
  }

  private async checkTenant(
    tenantId: string,
  ): Promise<ToolScopeViolationAlert | null> {
    const windowMinutes = this.config.toolScopeViolationCheckWindowMinutes;
    const threshold = this.config.toolScopeViolationAlertThreshold;

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(agentRuns)
          .where(
            sql`${agentRuns.escalationReason} = 'TOOL_SCOPE_VIOLATION' and ${agentRuns.createdAt} > now() - (${windowMinutes} || ' minutes')::interval`,
          ),
      tenantId,
    );

    const violationCount = row?.count ?? 0;
    const isOverThreshold = violationCount >= threshold;

    if (
      !this.debouncer.shouldFire(
        debounceKeyForTenant(tenantId),
        isOverThreshold,
      )
    ) {
      return null;
    }

    const alert: ToolScopeViolationAlert = {
      tenantId,
      violationCount,
      threshold,
      windowMinutes,
    };
    this.alertEvents.fire(alert);
    return alert;
  }
}
