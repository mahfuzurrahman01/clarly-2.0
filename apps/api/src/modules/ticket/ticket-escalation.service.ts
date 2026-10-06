// Product shell (TicketModule): the write path for creating a ticket.
// Feature 2's T3/T11 needed SOME ticket record before this module's real
// state machine existed (see tickets.table.ts's header comment on why the
// table itself was ALTERed, not replaced, for Feature 5). Every caller now
// resolves a `customerId` (CustomerModule, T13) before calling this —
// TicketModule itself stays uncoupled from CustomerModule; the resolving
// happens at each call site (WebhookModule), matching the narrow
// single-purpose service style used throughout this codebase.
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { tickets } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { TicketEventsService } from './ticket-events.service';
import type { CreateTicketInput, TicketRecord } from './ticket.dto';
import { toTicketRecord } from './ticket-record.mapper';

/** Not yet RESOLVED — an OPEN or CLAIMED ticket still represents work a human owes this conversation. */
const OPEN_STATUSES = ['OPEN', 'CLAIMED'] as const;

@Injectable()
export class TicketEscalationService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ticketEvents: TicketEventsService,
  ) {}

  /**
   * Launch billing backend (Lane A): deduplicated to at most one open
   * ticket per conversation.
   *
   * Before this pass, a conversation that escalated more than once before
   * anyone claimed the first ticket (e.g. a normal in-band escalation
   * followed by a DELIVERY_FAILURE on the same turn, or a JOB_FAILURE retry
   * hitting a conversation that had already escalated) produced a second,
   * third, ... ticket for the exact same conversation — the kanban board
   * filled with duplicates of the same underlying "a human needs to look at
   * this" event, and claiming one left the others sitting open forever.
   *
   * Scoped to a non-null `conversationId` only: T3's non-agent-run tickets
   * (unsupported media, no conversation resolved yet) have nothing to
   * dedup against and keep creating a ticket per call, same as before.
   *
   * A duplicate call does NOT open a second ticket, but it DOES append its
   * note to the existing one and re-emits the ticket-changed event — the
   * new escalation's context (e.g. "delivery also failed") is real
   * information a human should see, even though it doesn't get its own
   * ticket.
   */
  async createTicket(input: CreateTicketInput): Promise<TicketRecord> {
    if (input.conversationId) {
      const existing = await this.findOpenTicketForConversation(
        input.tenantId,
        input.conversationId,
      );
      if (existing) {
        return this.appendDedupNote(input, existing);
      }
    }

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tickets)
          .values({
            tenantId: input.tenantId,
            customerId: input.customerId,
            conversationId: input.conversationId ?? null,
            escalationReason: input.escalationReason,
            note: input.note,
            confidence: input.confidence ?? null,
            citedChunkIds: input.citedChunkIds ?? null,
          })
          .returning(),
      input.tenantId,
    );

    const ticket = toTicketRecord(row);
    this.ticketEvents.emitTicketChanged(input.tenantId, ticket);
    return ticket;
  }

  private async findOpenTicketForConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<TicketRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tickets)
          .where(
            and(
              eq(tickets.tenantId, tenantId),
              eq(tickets.conversationId, conversationId),
              inArray(tickets.status, OPEN_STATUSES),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toTicketRecord(rows[0]) : null;
  }

  private async appendDedupNote(
    input: CreateTicketInput,
    existing: TicketRecord,
  ): Promise<TicketRecord> {
    // F25/D5.1 item 6. createTicket() folds a second escalation in this
    // conversation into a note on the first ticket — which would make a
    // complaint INVISIBLE to the complaint lane forever when the customer
    // first asked something the agent could not answer (KB_NOT_INDEXED) and
    // only then complained. A complaint therefore PROMOTES the ticket's
    // reason. One-way on purpose: a complaint is never demoted back by a
    // later, lesser escalation in the same conversation.
    const promoteReason =
      input.escalationReason === 'CUSTOMER_COMPLAINT' &&
      existing.escalationReason !== 'CUSTOMER_COMPLAINT';

    if (!input.note && !promoteReason) return existing;

    const mergedNote = input.note
      ? existing.note
        ? `${existing.note}\n---\n${input.note}`
        : input.note
      : existing.note;

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tickets)
          .set({
            note: mergedNote,
            ...(promoteReason
              ? { escalationReason: 'CUSTOMER_COMPLAINT' as const }
              : {}),
          })
          .where(eq(tickets.id, existing.id))
          .returning(),
      input.tenantId,
    );

    const ticket = toTicketRecord(row);
    this.ticketEvents.emitTicketChanged(input.tenantId, ticket);
    return ticket;
  }
}
