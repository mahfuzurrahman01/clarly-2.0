// Product shell (NotificationsModule, T4/T18): the subscriber those four
// alert event services have been waiting for since Feature 7.
//
// Every one of them was built as "fire the mechanism, defer the channel",
// and the channel never arrived — so a ticket escalating and then sitting
// unclaimed produced a log line nobody outside this repo can read. That is
// the product's central promise (a human picks it up) failing quietly. This
// class turns those events into rows a tenant can actually see.
//
// PlatformHealthAlertEventsService is deliberately NOT subscribed here: its
// alerts carry no tenantId because they are about our infrastructure
// (circuit breaker open, DLQ depth, dependency unreachable). Those belong to
// whoever operates the platform, and showing a tenant our queue depth would
// be meaningless to them and a leak for us.
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AppLoggerService } from '../core';
import { LatencyBudgetAlertEventsService } from '../alerting/latency-budget-alert-events.service';
import { StuckTicketAlertEventsService } from '../alerting/stuck-ticket-alert-events.service';
import { ToolScopeViolationAlertEventsService } from '../alerting/tool-scope-violation-alert-events.service';
import type { LatencyBudgetAlert } from '../alerting/latency-budget-alert.dto';
import type { StuckTicketAlert } from '../alerting/stuck-ticket-alert.dto';
import type { ToolScopeViolationAlert } from '../alerting/tool-scope-violation-alert.dto';
import { AlertEmailService } from './alert-email.service';
import { notificationContent } from './notification-content';
import { NotificationService } from './notification.service';

/**
 * Condition-level alerts (latency, tool scope) re-notify at most once an
 * hour. The debouncer upstream already suppresses a sustained condition, but
 * it re-arms on recovery, so a metric flapping either side of its budget
 * would otherwise notify on every crossing.
 */
function hourBucket(at: Date): string {
  return at.toISOString().slice(0, 13);
}

@Injectable()
export class AlertNotificationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly onStuckTicket = (alert: StuckTicketAlert): void => {
    void this.record(alert.tenantId, {
      ...notificationContent.ticketStuck({
        minutes: alert.unclaimedMinutes,
        thresholdMinutes: alert.thresholdMinutes,
      }),
      // Critical, not warning: an unclaimed escalation is a customer waiting
      // on a human who does not know they exist.
      severity: 'critical',
      entityType: 'ticket',
      entityId: alert.ticketId,
      // Once per ticket, ever — the sweep re-fires for the same ticket on
      // every run until someone claims it.
      dedupKey: `ticket_stuck:${alert.ticketId}`,
    });
  };

  private readonly onLatencyBudget = (alert: LatencyBudgetAlert): void => {
    void this.record(alert.tenantId, {
      ...notificationContent.latencyBudgetExceeded({
        windowMinutes: alert.windowMinutes,
        p95Ms: alert.p95LatencyMs,
        budgetMs: alert.budgetMs,
        sampleSize: alert.sampleSize,
      }),
      severity: 'warning',
      dedupKey: `latency_budget:${hourBucket(new Date())}`,
    });
  };

  private readonly onToolScopeViolation = (
    alert: ToolScopeViolationAlert,
  ): void => {
    void this.record(alert.tenantId, {
      ...notificationContent.toolScopeViolations({
        violationCount: alert.violationCount,
        windowMinutes: alert.windowMinutes,
        threshold: alert.threshold,
      }),
      severity: 'warning',
      dedupKey: `tool_scope:${hourBucket(new Date())}`,
    });
  };

  constructor(
    private readonly notifications: NotificationService,
    private readonly alertEmail: AlertEmailService,
    private readonly stuckTicketAlerts: StuckTicketAlertEventsService,
    private readonly latencyAlerts: LatencyBudgetAlertEventsService,
    private readonly toolScopeAlerts: ToolScopeViolationAlertEventsService,
    private readonly logger: AppLoggerService,
  ) {}

  onModuleInit(): void {
    this.stuckTicketAlerts.onAlert(this.onStuckTicket);
    this.latencyAlerts.onAlert(this.onLatencyBudget);
    this.toolScopeAlerts.onAlert(this.onToolScopeViolation);
  }

  onModuleDestroy(): void {
    this.stuckTicketAlerts.offAlert(this.onStuckTicket);
    this.latencyAlerts.offAlert(this.onLatencyBudget);
    this.toolScopeAlerts.offAlert(this.onToolScopeViolation);
  }

  /**
   * Listeners are synchronous (EventEmitter) and the write is not, so a
   * failure here has nowhere to propagate: it must never take down the sweep
   * that fired the alert. Swallowed with a log — losing a notification is
   * bad, losing the stuck-ticket sweep for every tenant is worse.
   *
   * Mail goes out only for a `critical` alert, and only when the write
   * actually created a row. `record()` dedupes on `dedupKey`, so the second
   * condition is what stops the stuck-ticket sweep — which re-fires for the
   * same ticket on every run until somebody claims it — from mailing the same
   * escalation every few minutes. The row is the source of truth for "have we
   * already told them"; the mail follows it rather than keeping its own state.
   */
  private async record(
    tenantId: string,
    input: Omit<Parameters<NotificationService['record']>[0], 'tenantId'>,
  ): Promise<void> {
    try {
      const created = await this.notifications.record({ tenantId, ...input });
      if (created && input.severity === 'critical') {
        await this.alertEmail.sendCriticalAlert({
          tenantId,
          title: input.title,
          body: input.body,
          entityType: input.entityType,
          entityId: input.entityId,
        });
      }
    } catch (error) {
      this.logger.error(
        `failed to record a ${input.kind} notification for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'AlertNotificationSubscriber',
      );
    }
  }
}
