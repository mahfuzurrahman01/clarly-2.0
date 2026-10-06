// Product shell (MetricsModule): what your agent could not answer this week.
//
// Every other metric tells a tenant HOW OFTEN the agent failed. This one
// tells them WHAT TO DO about it: the actual customer questions behind the
// escalations, grouped by the kind of content gap that caused them. It is
// built entirely from data already captured at escalation time (A8's
// `agent_runs`), so it costs a query rather than a new pipeline.
//
// Only content-shaped reasons are included. A tool failure or a delivery
// failure is our problem or the BSP's; putting them on a screen headed "write
// this documentation" would send a tenant off to fix something they cannot.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { agentRuns, messages } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { DateRange } from './metrics.dto';

/**
 * The escalation reasons a tenant can actually fix by writing or reconciling
 * a document.
 *
 * - KB_NOT_INDEXED: nothing in the knowledge base covers this at all.
 * - CONFIDENCE_BELOW_THRESHOLD: something covers it, badly enough that the
 *   agent would not stand behind the answer.
 * - KB_CONFLICT: two documents disagree, and the fix is to reconcile them.
 */
export const KNOWLEDGE_GAP_REASONS = [
  'KB_NOT_INDEXED',
  'CONFIDENCE_BELOW_THRESHOLD',
  'KB_CONFLICT',
] as const;

export type KnowledgeGapReason = (typeof KNOWLEDGE_GAP_REASONS)[number];

export interface KnowledgeGap {
  reason: KnowledgeGapReason;
  /**
   * What the customer actually asked. Null once the transcript has been
   * purged (T16) — the run survives 90 days, the message does not, and a
   * missing question is reported rather than dropping the row and quietly
   * under-counting the gap.
   */
  question: string | null;
  occurredAt: Date;
  conversationId: string | null;
}

export interface KnowledgeGapReport {
  /** Newest first: the question a tenant is most likely to still remember. */
  gaps: KnowledgeGap[];
  /** How many of each kind in range, including ones beyond the returned page. */
  totals: { reason: KnowledgeGapReason; count: number }[];
}

@Injectable()
export class KnowledgeGapService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async getReport(
    tenantId: string,
    range: DateRange,
    limit: number,
  ): Promise<KnowledgeGapReport> {
    const inRange = and(
      eq(agentRuns.tenantId, tenantId),
      inArray(agentRuns.escalationReason, [...KNOWLEDGE_GAP_REASONS]),
      gte(agentRuns.createdAt, range.from),
      lte(agentRuns.createdAt, range.to),
    );

    const [rows, totals] = await Promise.all([
      // Executed as one statement rather than built with `.select({...})`.
      // The question comes from a CORRELATED subquery, and a `sql` fragment
      // in a select-field position does not carry the outer row's columns
      // into it — the predicates were silently dropped, so every row came
      // back with the same (newest overall) message. Caught only because the
      // live response showed one customer's words against four different
      // conversations.
      this.tenantContext.withTenantTx(
        (tx) =>
          tx.execute<{
            reason: string;
            occurred_at: string | Date;
            conversation_id: string | null;
            question: string | null;
          }>(sql`
            select
              r.escalation_reason as reason,
              r.created_at as occurred_at,
              r.conversation_id,
              (
                select m.content
                from ${messages} m
                where m.conversation_id = r.conversation_id
                  and m.role = 'user'
                  and m.created_at <= r.created_at
                order by m.created_at desc
                limit 1
              ) as question
            from ${agentRuns} r
            where r.tenant_id = ${tenantId}::uuid
              and r.escalation_reason in (${sql.join(
                KNOWLEDGE_GAP_REASONS.map((reason) => sql`${reason}`),
                sql`, `,
              )})
              and r.created_at >= ${range.from}
              and r.created_at <= ${range.to}
            order by r.created_at desc
            limit ${limit}
          `),
        tenantId,
      ),
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({
              reason: agentRuns.escalationReason,
              count: sql<number>`count(*)::int`,
            })
            .from(agentRuns)
            .where(inRange)
            .groupBy(agentRuns.escalationReason),
        tenantId,
      ),
    ]);

    return {
      gaps: rows.rows.map((row) => ({
        reason: row.reason as KnowledgeGapReason,
        question: row.question,
        occurredAt: new Date(row.occurred_at),
        conversationId: row.conversation_id,
      })),
      totals: totals.map((row) => ({
        reason: row.reason as KnowledgeGapReason,
        count: Number(row.count),
      })),
    };
  }
}
