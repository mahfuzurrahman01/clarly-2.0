// Product shell (TicketModule, T7/T8): the kanban console's state machine —
// OPEN -> CLAIMED -> RESOLVED, or OPEN -> RESOLVED directly (an agent can
// resolve without formally claiming first). RESOLVED is terminal this
// pass — no reopen flow specified, kept simple rather than guessed at.
import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { ConversationOutcomeService } from '../outcomes/conversation-outcome.service';
import { tickets } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { InvalidTicketTransitionError } from './invalid-ticket-transition.error';
import { TicketEventsService } from './ticket-events.service';
import { toTicketRecord } from './ticket-record.mapper';
import type { TicketRecord } from './ticket.dto';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';
import type { DrizzleDb } from '../persistence/persistence.providers';

/**
 * QA 2026-10-05: "a ticket has gone unanswered" is stale once somebody owns or
 * closes the ticket. Retired in the transaction that changed the ticket, so
 * the bell badge and the board can never disagree about it.
 */
function retireStuckNotification(
  tx: DrizzleDb,
  tenantId: string,
  ticketId: string,
  readAt: Date,
): Promise<number> {
  return markEntityNotificationsRead(tx, {
    tenantId,
    entityType: 'ticket',
    entityIds: [ticketId],
    kinds: ['ticket_stuck'],
    readAt,
  });
}

@Injectable()
export class TicketStateService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ticketEvents: TicketEventsService,
    private readonly conversationOutcome: ConversationOutcomeService,
  ) {}

  /** `assigneeId` is the claiming agent's Supabase Auth `sub` — see tickets.table.ts for why there's no local FK. */
  async claim(
    tenantId: string,
    ticketId: string,
    assigneeId: string,
  ): Promise<TicketRecord> {
    const existing = await this.getOrThrow(tenantId, ticketId);
    if (existing.status !== 'OPEN') {
      throw new InvalidTicketTransitionError(existing.status, 'CLAIMED');
    }

    const now = new Date();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(tickets)
        .set({ status: 'CLAIMED', assigneeId, claimedAt: now })
        .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
        .returning();
      await retireStuckNotification(tx, tenantId, ticketId, now);
      return rows;
    }, tenantId);

    const ticket = toTicketRecord(row);
    this.ticketEvents.emitTicketChanged(tenantId, ticket);
    return ticket;
  }

  /**
   * Hands a ticket to a specific person, or takes it off everyone.
   *
   * Distinct from `claim()`, which is "I am taking this" and refuses anything
   * that is not OPEN. Reassignment has to work on a ticket someone else
   * already holds — that is the entire point of it, and the case
   * `assigneeId` has been written-and-never-read for since T13.
   *
   * A RESOLVED ticket is left alone: moving a closed ticket back into
   * someone's queue would resurrect work the team already finished.
   */
  async assign(
    tenantId: string,
    ticketId: string,
    assigneeId: string | null,
  ): Promise<TicketRecord> {
    const existing = await this.getOrThrow(tenantId, ticketId);
    if (existing.status === 'RESOLVED') {
      throw new InvalidTicketTransitionError(
        existing.status,
        assigneeId ? 'CLAIMED' : 'OPEN',
      );
    }

    const now = new Date();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(tickets)
        .set(
          assigneeId
            ? {
                status: 'CLAIMED',
                assigneeId,
                // Reassignment restarts the clock: the new owner has not
                // had the ticket for the hour the last one sat on it, and
                // the stuck sweep should judge them on their own time.
                claimedAt: now,
              }
            : {
                // Unassigned means back in the queue, which is OPEN — a
                // CLAIMED ticket with no assignee is a ticket nobody is
                // working that also alerts nobody.
                status: 'OPEN',
                assigneeId: null,
                claimedAt: null,
              },
        )
        .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
        .returning();
      // Only handing it TO someone settles "nobody has picked it up";
      // unassigning puts it back in exactly that state.
      if (assigneeId) {
        await retireStuckNotification(tx, tenantId, ticketId, now);
      }
      return rows;
    }, tenantId);

    const ticket = toTicketRecord(row);
    this.ticketEvents.emitTicketChanged(tenantId, ticket);
    return ticket;
  }

  /**
   * Puts every unresolved ticket held by one person back in the queue.
   *
   * Exists for team removal: `assigneeId` is a Supabase Auth user id with no
   * local foreign key, so removing someone from a workspace leaves their
   * claimed tickets pointing at a person who can no longer sign in. Those
   * tickets are not OPEN, so nobody else picks them up, and the stuck-ticket
   * sweep keeps alerting on work that has no owner and cannot get one.
   *
   * RESOLVED tickets are left alone for the same reason assign() leaves them
   * alone — finished work must not come back.
   */
  async releaseAssignmentsFor(
    tenantId: string,
    assigneeId: string,
  ): Promise<number> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tickets)
          .set({ status: 'OPEN', assigneeId: null, claimedAt: null })
          .where(
            and(
              eq(tickets.tenantId, tenantId),
              eq(tickets.assigneeId, assigneeId),
              ne(tickets.status, 'RESOLVED'),
            ),
          )
          .returning(),
      tenantId,
    );

    for (const row of rows) {
      this.ticketEvents.emitTicketChanged(tenantId, toTicketRecord(row));
    }

    return rows.length;
  }

  async resolve(tenantId: string, ticketId: string): Promise<TicketRecord> {
    const existing = await this.getOrThrow(tenantId, ticketId);
    if (existing.status === 'RESOLVED') {
      throw new InvalidTicketTransitionError(existing.status, 'RESOLVED');
    }

    const now = new Date();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(tickets)
        .set({ status: 'RESOLVED', resolvedAt: now })
        .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
        .returning();
      await retireStuckNotification(tx, tenantId, ticketId, now);
      return rows;
    }, tenantId);

    const ticket = toTicketRecord(row);
    this.ticketEvents.emitTicketChanged(tenantId, ticket);

    // A9: "conversation close resolver" — a RESOLVED ticket is one of the
    // two real close events this codebase can observe (the other is
    // AutoCloseSweepService's inactivity heuristic). Only recorded when
    // the ticket actually has a conversationId — T3's non-agent-run
    // tickets (unsupported media) don't always have one, and there's
    // nothing meaningful to attribute an outcome to without it.
    if (ticket.conversationId) {
      await this.conversationOutcome.recordTicketResolved(
        tenantId,
        ticket.conversationId,
        ticket.escalationReason,
      );
    }

    return ticket;
  }

  private async getOrThrow(
    tenantId: string,
    ticketId: string,
  ): Promise<TicketRecord> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
          .limit(1),
      tenantId,
    );
    if (!rows[0]) {
      throw new NotFoundException(`Ticket ${ticketId} not found`);
    }
    return toTicketRecord(rows[0]);
  }
}
