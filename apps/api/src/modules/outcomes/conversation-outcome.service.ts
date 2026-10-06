// OutcomesModule (Feature 7, A9 "conversation close resolver"): the write
// path for `conversation_outcomes`. Two distinct close events, matching
// the two ways a conversation actually ends per this codebase's current
// state machine:
//   - `recordTicketResolved()` — called from `TicketStateService.resolve()`
//     (T7's state machine) the moment a ticket transitions to RESOLVED.
//     One outcome row per resolution, not "one per conversation ever" —
//     a conversation could in principle accumulate more than one ticket
//     over its life (no reopen flow exists, but nothing prevents a new
//     escalation on an already-resolved thread), and each resolution is
//     its own real data point for D13's "escalation_source split."
//   - `recordAutoResolved()` — called from `AutoCloseSweepService`'s
//     periodic scan for conversations that never escalated at all and
//     have gone quiet. There's no explicit "the AI successfully finished"
//     event anywhere in this codebase (AgentRuntime.respond() just
//     returns; nothing marks a conversation done), so inactivity is the
//     best available proxy — same heuristic Feature 5's MetricsService
//     used for its live computation, now captured as a permanent record
//     instead of recomputed on every read.
import { Injectable } from '@nestjs/common';
import type { EscalationReason } from '@repo/errors';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { conversationOutcomes, messages } from '../persistence/drizzle/schema';
import type { DrizzleDb } from '../persistence/persistence.providers';
import { TenantContextService } from '../tenant-context/tenant-context.service';

@Injectable()
export class ConversationOutcomeService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Phase 5 item 1: the wait the customer actually experienced at the start of
   * this conversation — first inbound message to the first reply that followed
   * it. 'assistant' and 'human_agent' both count: from the customer's side one
   * wait ended, and splitting them would make the pilot number unquotable for a
   * tenant whose agents take over early.
   *
   * Read inside the SAME transaction as the outcome insert, so the value is
   * consistent with the conversation as it stood at close time. Returns null
   * when nothing was ever sent back — that is an absent measurement, not a zero,
   * and a zero would drag a median toward "instant" for conversations we never
   * answered at all.
   */
  private async measureFirstResponseMs(
    tx: DrizzleDb,
    tenantId: string,
    conversationId: string,
  ): Promise<number | null> {
    const [firstInbound] = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, conversationId),
          eq(messages.role, 'user'),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1);
    if (!firstInbound) return null;

    const [firstReply] = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, conversationId),
          inArray(messages.role, ['assistant', 'human_agent']),
          gt(messages.createdAt, firstInbound.createdAt),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1);
    if (!firstReply) return null;

    return firstReply.createdAt.getTime() - firstInbound.createdAt.getTime();
  }

  async recordTicketResolved(
    tenantId: string,
    conversationId: string,
    escalationReason: EscalationReason | null,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      async (tx) =>
        tx.insert(conversationOutcomes).values({
          tenantId,
          conversationId,
          escalated: true,
          escalationReason,
          closedAt: new Date(),
          closeReason: 'ticket_resolved',
          firstResponseMs: await this.measureFirstResponseMs(
            tx,
            tenantId,
            conversationId,
          ),
        }),
      tenantId,
    );
  }

  async recordAutoResolved(
    tenantId: string,
    conversationId: string,
    closedAt: Date,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      async (tx) =>
        tx.insert(conversationOutcomes).values({
          tenantId,
          conversationId,
          escalated: false,
          escalationReason: null,
          closedAt,
          closeReason: 'inactivity_timeout',
          firstResponseMs: await this.measureFirstResponseMs(
            tx,
            tenantId,
            conversationId,
          ),
        }),
      tenantId,
    );
  }
}
