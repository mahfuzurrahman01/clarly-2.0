// AlertingModule (Feature 7/8, T18): same shape as
// StuckTicketAlertEventsService/LatencyBudgetAlertEventsService — a
// structured `warn`-level log (a real signal today) plus an in-process
// EventEmitter re-emit for a future notification channel (still not
// built) to subscribe to.
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AppLoggerService } from '../core';
import type { PlatformHealthAlert } from './platform-health-alert.dto';

const PLATFORM_HEALTH_ALERT = 'platform-health.alert';

@Injectable()
export class PlatformHealthAlertEventsService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: AppLoggerService) {
    this.emitter.setMaxListeners(50);
  }

  fire(alert: PlatformHealthAlert): void {
    this.logger.warn(
      `[${alert.type}] ${alert.message} ${JSON.stringify(alert.details)}`,
      'PlatformHealthAlertEventsService',
    );
    this.emitter.emit(PLATFORM_HEALTH_ALERT, alert);
  }

  /** For a future notification channel (T18) to subscribe to — no consumer yet. */
  onAlert(listener: (alert: PlatformHealthAlert) => void): void {
    this.emitter.on(PLATFORM_HEALTH_ALERT, listener);
  }

  offAlert(listener: (alert: PlatformHealthAlert) => void): void {
    this.emitter.off(PLATFORM_HEALTH_ALERT, listener);
  }
}
