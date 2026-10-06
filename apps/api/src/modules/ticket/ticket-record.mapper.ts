import type {
  tickets,
  TicketEscalationReason,
  TicketStatus,
} from '../persistence/drizzle/schema';
import type { TicketRecord } from './ticket.dto';

/** Shared row->record mapping — TicketEscalationService (create), TicketStateService (claim/resolve), and TicketQueryService (list/get) all return the same shape from the same table, so this stays one function, not three copies. */
export function toTicketRecord(row: typeof tickets.$inferSelect): TicketRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    conversationId: row.conversationId,
    escalationReason: row.escalationReason as TicketEscalationReason,
    status: row.status as TicketStatus,
    note: row.note,
    assigneeId: row.assigneeId,
    confidence: row.confidence,
    citedChunkIds: row.citedChunkIds,
    claimedAt: row.claimedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}
