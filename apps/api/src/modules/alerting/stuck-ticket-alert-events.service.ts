// Product shell (AlertingModule, T4): "Escalate to tenant-admin
// notification (email/WhatsApp/webhook, tenant's choice)." No delivery
// vendor is chosen or integrated yet — same "build the mechanism, defer
// the vendor" pattern as T0 (BSP), Supabase Storage (F2.5), and
// KanbanModule's SSE bus (Feature 5 slice 3). This service IS the
// mechanism: it fires a structured warning log (a real, searchable signal
// today) and re-emits the same alert over an in-process EventEmitter so a
// future email/WhatsApp/webhook channel (T18) can subscribe without this
// service or StuckTicketCheckService changing at all.
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AppLoggerService } from '../core';
import type { StuckTicketAlert } from './stuck-ticket-alert.dto';

const STUCK_TICKET_ALERT = 'stuck-ticket.alert';

@Injectable()
export class StuckTicketAlertEventsService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: AppLoggerService) {
    this.emitter.setMaxListeners(50);
  }

  fire(alert: StuckTicketAlert): void {
    this.logger.warn(
      `Ticket ${alert.ticketId} (tenant ${alert.tenantId}) has been unclaimed for ` +
        `${alert.unclaimedMinutes}m, past its ${alert.thresholdMinutes}m threshold`,
      'StuckTicketAlertEventsService',
    );
    this.emitter.emit(STUCK_TICKET_ALERT, alert);
  }

  /** For a future notification channel (email/WhatsApp/webhook, T18) to subscribe to — no consumer yet. */
  onAlert(listener: (alert: StuckTicketAlert) => void): void {
    this.emitter.on(STUCK_TICKET_ALERT, listener);
  }

  offAlert(listener: (alert: StuckTicketAlert) => void): void {
    this.emitter.off(STUCK_TICKET_ALERT, listener);
  }
}
