// Product shell (AlertingModule, T9): same shape as
// StuckTicketAlertEventsService (T4) — a structured `warn`-level log (a
// real signal today) plus an in-process EventEmitter re-emit for a future
// notification channel (T18) to subscribe to, once one exists. Kept as
// its own dedicated service rather than generalizing a single shared
// "AlertEventsService" across both alert types — each alert carries a
// different, type-specific payload shape, and the "many small files, one
// responsibility each" pattern this codebase already follows elsewhere
// favors two small services over one that discriminates on an alert-type
// field internally.
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AppLoggerService } from '../core';
import type { LatencyBudgetAlert } from './latency-budget-alert.dto';

const LATENCY_BUDGET_ALERT = 'latency-budget.alert';

@Injectable()
export class LatencyBudgetAlertEventsService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: AppLoggerService) {
    this.emitter.setMaxListeners(50);
  }

  fire(alert: LatencyBudgetAlert): void {
    this.logger.warn(
      `Tenant ${alert.tenantId}'s p95 respond-path latency is ${alert.p95LatencyMs}ms over the last ` +
        `${alert.windowMinutes}m (n=${alert.sampleSize}), past the ${alert.budgetMs}ms budget`,
      'LatencyBudgetAlertEventsService',
    );
    this.emitter.emit(LATENCY_BUDGET_ALERT, alert);
  }

  /** For a future notification channel (T18) to subscribe to — no consumer yet. */
  onAlert(listener: (alert: LatencyBudgetAlert) => void): void {
    this.emitter.on(LATENCY_BUDGET_ALERT, listener);
  }

  offAlert(listener: (alert: LatencyBudgetAlert) => void): void {
    this.emitter.off(LATENCY_BUDGET_ALERT, listener);
  }
}
