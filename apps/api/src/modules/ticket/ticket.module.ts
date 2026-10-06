import { Module } from '@nestjs/common';
import { OutcomesModule } from '../outcomes/outcomes.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TicketEscalationService } from './ticket-escalation.service';
import { TicketEventsService } from './ticket-events.service';
import { TicketQueryService } from './ticket-query.service';
import { TicketStateService } from './ticket-state.service';

export * from './ticket.dto';
export * from './invalid-ticket-transition.error';
export { TicketEscalationService } from './ticket-escalation.service';
export { TicketStateService } from './ticket-state.service';
export {
  TicketQueryService,
  type ListTicketsFilters,
} from './ticket-query.service';
export {
  TicketEventsService,
  type TicketChangedEvent,
} from './ticket-events.service';

// Product shell: handoff-context assembly, state machine, batch loaders (T8). No dependency-rule constraints apply directly.
//
// THIS PASS (Feature 5, T7/T8-proper): `TicketEscalationService` (create —
// extended for T13's customerId + D10's confidence/citations captured at
// creation time), `TicketStateService` (the OPEN -> CLAIMED -> RESOLVED
// state machine, T7's claim/resolve actions), `TicketQueryService` (T8's
// batch-loaded list/get, transcript + citations + confidence in a bounded
// number of queries, never N+1), `TicketEventsService` (in-process pub/sub
// feeding KanbanModule's SSE stream on every create/claim/resolve).
// `KanbanModule` wraps these in the actual HTTP/SSE console API.
@Module({
  imports: [TenantContextModule, OutcomesModule],
  controllers: [],
  providers: [
    TicketEscalationService,
    TicketStateService,
    TicketQueryService,
    TicketEventsService,
  ],
  exports: [
    TicketEscalationService,
    TicketStateService,
    TicketQueryService,
    TicketEventsService,
  ],
})
export class TicketModule {}
