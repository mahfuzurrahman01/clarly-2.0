// Product shell (AlertingModule, T4): the actual stuck-ticket sweep.
// Deliberately reuses T8's batch loader (`TicketQueryService`) and T15's
// policy reader (`TenantPolicyService`) rather than writing a second,
// parallel query path against `tickets` — the only genuinely new query
// here is "list every tenant" (`tenants` isn't RLS-scoped, so this is the
// one place in AlertingModule that needs `PersistenceService`'s admin
// escape hatch instead of `TenantContextService.withTenantTx()`).
import { Injectable } from '@nestjs/common';
import { tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES } from '../onboarding/tenant-policy.dto';
import { TenantPolicyService } from '../onboarding/tenant-policy.service';
import { AgentConfigService } from '../agent-config/agent-config.service';
import { businessMinutesBetween } from '../agent-config/business-hours';
import { TicketQueryService } from '../ticket/ticket-query.service';
import { AppLoggerService, sweepTenantsWithBoundedConcurrency } from '../core';
import { StuckTicketAlertEventsService } from './stuck-ticket-alert-events.service';
import type { StuckTicketAlert } from './stuck-ticket-alert.dto';

const MINUTE_MS = 60_000;

@Injectable()
export class StuckTicketCheckService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantPolicy: TenantPolicyService,
    private readonly ticketQuery: TicketQueryService,
    private readonly alertEvents: StuckTicketAlertEventsService,
    private readonly agentConfig: AgentConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Sweeps every tenant, fires an alert per stuck ticket found, and returns
   * the full batch (useful for tests/observability — callers don't need to
   * re-derive it from log lines).
   *
   * Bounded concurrency, one tenant's failure never dropping the rest: see
   * sweep-tenants.ts's own doc comment for why the previous bare
   * `Promise.all(tenantRows.map(...))` here was the actual cause of this
   * sweep landing in the BullMQ failed set as tenant count grew.
   */
  async checkAllTenants(): Promise<StuckTicketAlert[]> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    const results = await sweepTenantsWithBoundedConcurrency(
      tenantRows.map((tenant) => tenant.id),
      (tenantId) => this.checkTenant(tenantId),
      { logger: this.logger, sweepName: 'stuck-ticket-check' },
    );

    return results.flatMap((result) => result.value);
  }

  private async checkTenant(tenantId: string): Promise<StuckTicketAlert[]> {
    const policy = await this.tenantPolicy.getForTenant(tenantId);
    const thresholdMinutes =
      policy?.stuckTicketThresholdMinutes ??
      DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES;

    // Business hours turn "unclaimed for N minutes" into "unclaimed for N
    // minutes anyone could have claimed it". Without this, an escalation at
    // 3am is overdue before the tenant opens: the stuck count inflates
    // overnight, notifications fire that nobody can act on, and a tenant
    // learns to ignore both — which costs more than never having alerted.
    const schedule = await this.agentConfig.getTenantBusinessHours(tenantId);

    const openTickets = await this.ticketQuery.listWithContext(tenantId, {
      status: 'OPEN',
    });

    const now = Date.now();
    const alerts: StuckTicketAlert[] = [];

    for (const ticket of openTickets) {
      // Defensive, not load-bearing: an OPEN ticket's claimedAt is always
      // null under the current state machine (claiming sets status to
      // CLAIMED in the same update) — kept explicit so this check stays
      // correct if that invariant ever changes instead of silently
      // alerting on tickets someone already claimed.
      if (ticket.claimedAt !== null) continue;

      const unclaimedMinutes = schedule
        ? businessMinutesBetween(
            schedule.hours,
            schedule.timezone,
            ticket.createdAt,
            new Date(now),
          )
        : Math.floor((now - ticket.createdAt.getTime()) / MINUTE_MS);
      if (unclaimedMinutes < thresholdMinutes) continue;

      const alert: StuckTicketAlert = {
        tenantId,
        ticketId: ticket.id,
        customerId: ticket.customerId,
        createdAt: ticket.createdAt,
        unclaimedMinutes,
        thresholdMinutes,
      };
      this.alertEvents.fire(alert);
      alerts.push(alert);
    }

    return alerts;
  }
}
