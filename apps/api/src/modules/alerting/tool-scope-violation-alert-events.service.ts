// AlertingModule (T18): same shape as LatencyBudgetAlertEventsService —
// structured `warn`-level log + in-process EventEmitter re-emit for a
// future notification channel.
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AppLoggerService } from '../core';
import type { ToolScopeViolationAlert } from './tool-scope-violation-alert.dto';

const TOOL_SCOPE_VIOLATION_ALERT = 'tool-scope-violation.alert';

@Injectable()
export class ToolScopeViolationAlertEventsService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: AppLoggerService) {
    this.emitter.setMaxListeners(50);
  }

  fire(alert: ToolScopeViolationAlert): void {
    this.logger.warn(
      `Tenant ${alert.tenantId} had ${alert.violationCount} ToolScopeViolation(s) in the last ` +
        `${alert.windowMinutes}m, past the ${alert.threshold} threshold — possible cross-tenant probe`,
      'ToolScopeViolationAlertEventsService',
    );
    this.emitter.emit(TOOL_SCOPE_VIOLATION_ALERT, alert);
  }

  /** For a future notification channel (T18) to subscribe to — no consumer yet. */
  onAlert(listener: (alert: ToolScopeViolationAlert) => void): void {
    this.emitter.on(TOOL_SCOPE_VIOLATION_ALERT, listener);
  }

  offAlert(listener: (alert: ToolScopeViolationAlert) => void): void {
    this.emitter.off(TOOL_SCOPE_VIOLATION_ALERT, listener);
  }
}
