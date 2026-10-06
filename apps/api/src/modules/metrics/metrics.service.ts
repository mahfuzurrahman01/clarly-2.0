// Product shell (MetricsModule, A9): "resolution rate + escalation
// breakdown" — now reads from Feature 7's permanent, anonymized
// `conversation_outcomes` table (the A9-hardening swap; see
// docs/decisions/F7-observability.md, Slice 3) instead of Feature 5's
// live computation over `tickets`/`conversations` directly. Public
// contract (`getResolutionRate`/`getEscalationBreakdown`, same
// `ResolutionRateResult`/`EscalationBreakdown` shapes) is unchanged —
// `MetricsController` didn't need to change at all — but the underlying
// semantics shifted: both are now scoped to conversations that actually
// CLOSED within the date range (by `closedAt`), not conversations
// CREATED in range. This is the intentional, permanent version T12's
// "survives a 90-day transcript purge" guarantee depends on —
// `conversation_outcomes` rows are never touched by a future purge of
// raw `messages`/`conversations`/`tickets` (T16), unlike the live
// computation this replaces, which would have silently gone wrong (or
// empty) the moment old conversations/tickets were purged out from
// under it.
import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import {
  conversationOutcomes,
  type TicketEscalationReason,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  DateRange,
  EscalationBreakdown,
  FirstResponseTimeResult,
  ResolutionRateResult,
} from './metrics.dto';

@Injectable()
export class MetricsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** D13's "escalation_source split" — outcome count grouped by escalationReason, among conversations that closed (via ticket resolution) with an escalation, bucketed by closedAt within the range. */
  async getEscalationBreakdown(
    tenantId: string,
    range: DateRange,
  ): Promise<EscalationBreakdown> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            escalationReason: conversationOutcomes.escalationReason,
            count: sql<number>`count(*)::int`,
          })
          .from(conversationOutcomes)
          .where(
            and(
              eq(conversationOutcomes.tenantId, tenantId),
              eq(conversationOutcomes.escalated, true),
              gte(conversationOutcomes.closedAt, range.from),
              lte(conversationOutcomes.closedAt, range.to),
            ),
          )
          .groupBy(conversationOutcomes.escalationReason),
      tenantId,
    );

    const breakdown: EscalationBreakdown = {};
    for (const row of rows) {
      if (!row.escalationReason) continue;
      breakdown[row.escalationReason as TicketEscalationReason] = row.count;
    }
    return breakdown;
  }

  /**
   * "Resolved" = closed without ever needing a human (`escalated: false`
   * — `AutoCloseSweepService`'s inactivity heuristic) vs closed via a
   * human resolving an escalation (`escalated: true` —
   * `TicketStateService.resolve()`). Scoped to conversations that CLOSED
   * within the range, not conversations created in it — a still-open
   * conversation (escalated but not yet resolved, or simply still
   * active) contributes to neither the numerator nor denominator until
   * it actually closes, which is the correct denominator for "of the
   * conversations we finished handling in this window, what fraction
   * needed a human."
   */
  async getResolutionRate(
    tenantId: string,
    range: DateRange,
  ): Promise<ResolutionRateResult> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            escalated: conversationOutcomes.escalated,
            count: sql<number>`count(*)::int`,
          })
          .from(conversationOutcomes)
          .where(
            and(
              eq(conversationOutcomes.tenantId, tenantId),
              gte(conversationOutcomes.closedAt, range.from),
              lte(conversationOutcomes.closedAt, range.to),
            ),
          )
          .groupBy(conversationOutcomes.escalated),
      tenantId,
    );

    let resolvedConversations = 0;
    let totalConversations = 0;
    for (const row of rows) {
      totalConversations += row.count;
      // "Resolved" here means "resolved without needing a human" —
      // matches this method's own doc comment and Feature 5's original
      // definition, just now sourced from a permanent record instead of
      // a live guess.
      if (!row.escalated) resolvedConversations += row.count;
    }

    return {
      from: range.from,
      to: range.to,
      totalConversations,
      resolvedConversations,
      resolutionRate:
        totalConversations === 0
          ? 0
          : resolvedConversations / totalConversations,
    };
  }

  /**
   * Phase 5 item 1 (GULF_PARITY_PLAN.md): the case-study number beside
   * resolution rate — how long a customer waits for the first reply.
   *
   * MEDIAN, not mean: first-response time has a long right tail (a conversation
   * that opens at 3am waits for business hours), and a mean lets a handful of
   * those describe every customer's experience. The p90 is returned alongside
   * precisely so the tail is visible rather than averaged away.
   *
   * Reads `first_response_ms` off the outcome row (written at close time by
   * ConversationOutcomeService) rather than joining `messages`: same reason the
   * rest of this service moved to `conversation_outcomes` — T16's transcript
   * purge will remove those messages, and this number must survive it.
   */
  async getFirstResponseTime(
    tenantId: string,
    range: DateRange,
  ): Promise<FirstResponseTimeResult> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            measured: sql<number>`count(${conversationOutcomes.firstResponseMs})::int`,
            medianMs: sql<
              number | null
            >`percentile_cont(0.5) within group (order by ${conversationOutcomes.firstResponseMs})`,
            p90Ms: sql<
              number | null
            >`percentile_cont(0.9) within group (order by ${conversationOutcomes.firstResponseMs})`,
          })
          .from(conversationOutcomes)
          .where(
            and(
              eq(conversationOutcomes.tenantId, tenantId),
              gte(conversationOutcomes.closedAt, range.from),
              lte(conversationOutcomes.closedAt, range.to),
            ),
          ),
      tenantId,
    );

    // percentile_cont interpolates, so it returns a fractional millisecond;
    // rounding here keeps the published contract an integer count of ms.
    const round = (value: number | null | undefined): number | null =>
      value === null || value === undefined ? null : Math.round(Number(value));

    return {
      from: range.from,
      to: range.to,
      measuredConversations: row?.measured ?? 0,
      medianMs: round(row?.medianMs),
      p90Ms: round(row?.p90Ms),
    };
  }
}
