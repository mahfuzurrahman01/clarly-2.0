// ObservabilityModule (Launch Plan item 7): the paging channel
// PlatformHealthAlertEventsService was built without ("fire the mechanism,
// defer the channel" — the same gap AlertNotificationSubscriber closed for
// per-tenant alerts). Until this class existed, "circuit breaker open" /
// "DLQ depth" / "Postgres unreachable" was a warn-level log line and
// nothing else — visible only to someone already tailing logs, which is
// precisely not true during an outage nobody has noticed yet.
//
// Deliberately NOT in NotificationsModule/AlertNotificationSubscriber:
// that class's own doc comment explains why PlatformHealthAlertEventsService
// is excluded there — these alerts carry no tenantId, they're about OUR
// infrastructure, and showing a tenant our queue depth would be a leak. This
// is the platform-operator-facing counterpart, living in ObservabilityModule
// next to the Sentry wiring it uses.
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { AppConfigService, AppLoggerService } from '../core';
import { PlatformHealthAlertEventsService } from '../alerting/platform-health-alert-events.service';
import type { PlatformHealthAlert } from '../alerting/platform-health-alert.dto';
import { EmailSender } from '../email/ports/email-sender.port';

@Injectable()
export class PlatformHealthPagingSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly onAlert = (alert: PlatformHealthAlert): void => {
    this.page(alert);
  };

  constructor(
    private readonly alertEvents: PlatformHealthAlertEventsService,
    private readonly email: EmailSender,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  onModuleInit(): void {
    this.alertEvents.onAlert(this.onAlert);
  }

  onModuleDestroy(): void {
    this.alertEvents.offAlert(this.onAlert);
  }

  /**
   * Both channels are best-effort and independent of each other — a Sentry
   * outage must not suppress the email, and vice versa. Neither ever
   * throws back into the alert sweep that fired this (same rationale as
   * AlertNotificationSubscriber.record(): losing a page is bad, losing the
   * health sweep for every check is worse).
   */
  private page(alert: PlatformHealthAlert): void {
    this.pageSentry(alert);
    void this.pageEmail(alert);
  }

  /**
   * Sentry.captureMessage at 'error' level — not 'warning': every one of
   * these four alert types is already debounced (AlertDebouncer) so this
   * only fires on a real state change, and every one of them means "the
   * respond path is currently degraded or about to be." `alert.details` is
   * platform-scoped counts/thresholds/queue names (see
   * platform-health-alert.dto.ts) — never customer content — so it is safe
   * as Sentry `extra` context without the PII-scrubbing instrument.ts
   * applies to request data.
   */
  private pageSentry(alert: PlatformHealthAlert): void {
    if (!this.config.sentryDsn) return;
    Sentry.captureMessage(`[platform-health] ${alert.message}`, {
      level: 'error',
      tags: { alertType: alert.type },
      extra: alert.details,
    });
  }

  private async pageEmail(alert: PlatformHealthAlert): Promise<void> {
    const to = this.config.platformAlertEmail;
    if (!to) {
      this.logger.debug(
        `PLATFORM_ALERT_EMAIL unset — "${alert.type}" was not emailed (Sentry, if configured, is the only paging channel)`,
        'PlatformHealthPagingSubscriber',
      );
      return;
    }
    if (!this.email.isEnabled()) {
      this.logger.debug(
        `no mail provider configured — "${alert.type}" was not emailed`,
        'PlatformHealthPagingSubscriber',
      );
      return;
    }

    try {
      await this.email.send({
        to: [to],
        subject: `[Clarly platform] ${alert.message}`,
        text: platformAlertText(alert),
      });
      this.logger.log(
        `paged ${to} for platform-health alert "${alert.type}"`,
        'PlatformHealthPagingSubscriber',
      );
    } catch (error) {
      this.logger.error(
        `failed to email platform-health alert "${alert.type}" to ${to}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'PlatformHealthPagingSubscriber',
      );
    }
  }
}

function platformAlertText(alert: PlatformHealthAlert): string {
  const details = Object.entries(alert.details)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n');
  return `${alert.message}\n\n${details}\n`;
}
