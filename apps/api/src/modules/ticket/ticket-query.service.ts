// Product shell (TicketModule, T8): "Kanban ticket list must batch-load
// transcript + citations + confidence score per ticket in one query, not
// N+1." Citations (`citedChunkIds`) and confidence are already columns on
// `tickets` itself (captured at creation time from `AgentTurnResult`, see
// tickets.table.ts's header comment), so those come free with the first
// query — only the transcript needs a second, batched query. Two queries
// total regardless of how many tickets are in the list, never N+1.
import { Injectable } from '@nestjs/common';
import type { EscalationReason } from '@repo/errors';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  customerLabels,
  customers,
  messages,
  tickets,
  type TicketStatus,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { toTicketRecord } from './ticket-record.mapper';
import type { TicketWithContext } from './ticket.dto';

/** D7's recent-window size — the kanban console's transcript preview matches what the agent itself sees, not the full history. */
const TRANSCRIPT_WINDOW_SIZE = 10;

export interface ListTicketsFilters {
  status?: TicketStatus;
  /** A user id for "their tickets", or the literal 'unassigned' for the queue nobody owns. */
  assignee?: string | 'unassigned';
  /** F25/D5.1 item 5: one more predicate on the existing `and(...)`, not a new query. `CUSTOMER_COMPLAINT` renders the Complaints lane. */
  escalationReason?: EscalationReason;
}

@Injectable()
export class TicketQueryService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async listWithContext(
    tenantId: string,
    filters: ListTicketsFilters = {},
  ): Promise<TicketWithContext[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            ticket: tickets,
            customerPhone: customers.phone,
            customerName: customers.name,
            customerLabel: customerLabels.label,
            customerLabelOverriddenAt: customerLabels.overriddenAt,
          })
          .from(tickets)
          .innerJoin(customers, eq(tickets.customerId, customers.id))
          // LEFT, not INNER: most customers have no label yet, and an inner
          // join here would silently drop those tickets off the board.
          .leftJoin(
            customerLabels,
            and(
              eq(customerLabels.customerId, customers.id),
              // Belt-and-braces with RLS, and the convention every other query
              // here follows: the tenant predicate is written out, never left
              // implicit in the policy.
              eq(customerLabels.tenantId, tenantId),
            ),
          )
          .where(
            and(
              eq(tickets.tenantId, tenantId),
              filters.status ? eq(tickets.status, filters.status) : undefined,
              filters.assignee === undefined
                ? undefined
                : filters.assignee === 'unassigned'
                  ? isNull(tickets.assigneeId)
                  : eq(tickets.assigneeId, filters.assignee),
              filters.escalationReason
                ? eq(tickets.escalationReason, filters.escalationReason)
                : undefined,
            ),
          )
          .orderBy(desc(tickets.createdAt)),
      tenantId,
    );

    return this.attachTranscripts(tenantId, rows);
  }

  async getWithContext(
    tenantId: string,
    ticketId: string,
  ): Promise<TicketWithContext | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            ticket: tickets,
            customerPhone: customers.phone,
            customerName: customers.name,
            customerLabel: customerLabels.label,
            customerLabelOverriddenAt: customerLabels.overriddenAt,
          })
          .from(tickets)
          .innerJoin(customers, eq(tickets.customerId, customers.id))
          // LEFT, not INNER: most customers have no label yet, and an inner
          // join here would silently drop those tickets off the board.
          .leftJoin(
            customerLabels,
            and(
              eq(customerLabels.customerId, customers.id),
              // Belt-and-braces with RLS, and the convention every other query
              // here follows: the tenant predicate is written out, never left
              // implicit in the policy.
              eq(customerLabels.tenantId, tenantId),
            ),
          )
          .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
          .limit(1),
      tenantId,
    );

    const [result] = await this.attachTranscripts(tenantId, rows);
    return result ?? null;
  }

  /** The batched second query — one `WHERE conversation_id IN (...)` covering every ticket in the input, not one query per ticket. */
  private async attachTranscripts(
    tenantId: string,
    rows: Array<{
      ticket: typeof tickets.$inferSelect;
      customerPhone: string;
      customerName: string | null;
      customerLabel: string | null;
      customerLabelOverriddenAt: Date | null;
    }>,
  ): Promise<TicketWithContext[]> {
    const conversationIds = [
      ...new Set(
        rows
          .map((row) => row.ticket.conversationId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const messageRows =
      conversationIds.length === 0
        ? []
        : await this.tenantContext.withTenantTx(
            (tx) =>
              tx
                .select({
                  conversationId: messages.conversationId,
                  role: messages.role,
                  content: messages.content,
                })
                .from(messages)
                .where(
                  and(
                    inArray(messages.conversationId, conversationIds),
                    eq(messages.tenantId, tenantId),
                  ),
                )
                .orderBy(messages.createdAt),
            tenantId,
          );

    const transcriptsByConversation = new Map<
      string,
      TicketWithContext['transcript']
    >();
    for (const row of messageRows) {
      const list = transcriptsByConversation.get(row.conversationId) ?? [];
      list.push({
        role: row.role as 'user' | 'assistant',
        content: row.content,
      });
      transcriptsByConversation.set(row.conversationId, list);
    }
    for (const [conversationId, list] of transcriptsByConversation) {
      transcriptsByConversation.set(
        conversationId,
        list.slice(-TRANSCRIPT_WINDOW_SIZE),
      );
    }

    return rows.map((row) => ({
      ...toTicketRecord(row.ticket),
      customerPhone: row.customerPhone,
      customerName: row.customerName,
      customerLabel: row.customerLabel,
      // Derived from the override marker, exactly as CustomerLabelService
      // does — one rule for "who set this label", in both places that answer
      // it. Null when there is no label at all, not a defaulted 'agent'.
      customerLabelSource:
        row.customerLabel === null
          ? null
          : row.customerLabelOverriddenAt
            ? 'human'
            : 'agent',
      transcript: row.ticket.conversationId
        ? (transcriptsByConversation.get(row.ticket.conversationId) ?? [])
        : [],
    }));
  }
}
