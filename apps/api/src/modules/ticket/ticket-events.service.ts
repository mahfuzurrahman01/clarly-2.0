// Product shell (TicketModule): in-process pub/sub feeding KanbanModule's
// SSE stream (T7/T8). Deliberately a plain Node `EventEmitter`, not Redis
// pub/sub — this is the same "build the mechanism, defer the vendor/scale
// concern" pattern used throughout this codebase (T0 BSP, Supabase Storage
// in F2.5): single-API-instance real-time delivery works today; fanning
// SSE out correctly across multiple API instances needs a shared bus
// (Redis pub/sub, reusing the existing Redis connection QueueModule
// already holds) and is explicitly out of scope until horizontal scaling
// of the API process is actually a requirement.
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Observable } from 'rxjs';
import type { TicketRecord } from './ticket.dto';

export interface TicketChangedEvent {
  tenantId: string;
  ticket: TicketRecord;
}

const TICKET_CHANGED = 'ticket.changed';

@Injectable()
export class TicketEventsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Kanban consoles for busy tenants can plausibly have more than the
    // default 10 concurrent SSE listeners (multiple agents' browser tabs).
    this.emitter.setMaxListeners(100);
  }

  emitTicketChanged(tenantId: string, ticket: TicketRecord): void {
    this.emitter.emit(TICKET_CHANGED, { tenantId, ticket });
  }

  /** Tenant-filtered stream — a listener only ever sees its own tenant's tickets, same isolation guarantee RLS gives the DB layer, enforced here at the event-fan-out layer instead. */
  subscribe(tenantId: string): Observable<TicketRecord> {
    return new Observable<TicketRecord>((subscriber) => {
      const listener = (event: TicketChangedEvent): void => {
        if (event.tenantId === tenantId) {
          subscriber.next(event.ticket);
        }
      };
      this.emitter.on(TICKET_CHANGED, listener);
      return () => this.emitter.off(TICKET_CHANGED, listener);
    });
  }
}
