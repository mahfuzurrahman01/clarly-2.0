// BillingModule (Feature 8, T20): "Usage metering off the tokens/cost
// columns A8 already writes to agent_runs; ties into T17's spend-cap
// enforcement so metering and enforcement share one source of truth." No
// second accounting mechanism — `getMonthlyUsage()` is a pure aggregate
// read over `agent_runs`, and `checkEntitlement()` (T17's actual
// enforcement check, called from RespondPathProcessor) is built directly
// on top of it — the same query answers both "what's this tenant's
// monthly usage report" and "is this tenant over their cap right now."
import { Injectable } from '@nestjs/common';
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { agentRuns, plans } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BillingService } from './billing.service';
import type { TenantSubscriptionRecord } from './billing.dto';
import type {
  EntitlementBlockReason,
  EntitlementCheckResult,
  MonthlyUsageResult,
} from './usage.dto';

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonthUtc(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

@Injectable()
export class UsageService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Excludes `status: 'error'` rows — same reasoning
   * `LatencyBudgetCheckService` (T9) already documents: T11's exhausted-
   * retry path never made a real LLM call, so it always has
   * `inputTokens/outputTokens/costUsd: 0`; including it wouldn't inflate
   * usage numbers, but it's still not a real "message the tenant paid
   * for" in any accounting sense, so it's excluded on principle, not just
   * because it happens to be harmless.
   */
  async getMonthlyUsage(
    tenantId: string,
    periodStart: Date = startOfCurrentMonthUtc(),
  ): Promise<MonthlyUsageResult> {
    const periodEnd = startOfNextMonthUtc(periodStart);

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            messageCount: sql<number>`count(*)::int`,
            inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
            outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
            totalCostUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
          })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.tenantId, tenantId),
              ne(agentRuns.status, 'error'),
              gte(agentRuns.createdAt, periodStart),
              lt(agentRuns.createdAt, periodEnd),
            ),
          ),
      tenantId,
    );

    return {
      tenantId,
      periodStart,
      periodEnd,
      messageCount: row?.messageCount ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      totalCostUsd: row?.totalCostUsd ?? 0,
    };
  }

  /**
   * Launch billing backend (Lane A): the real "is this tenant allowed to
   * receive an AI reply right now" gate, checked BEFORE T17's usage-cap
   * enforcement below. `allowed` is:
   *   - `comped` -> always true, independent of status/trialEndsAt (a
   *     platform operator's decision overrides billing entirely).
   *   - `active` -> true.
   *   - `trialing` -> true only while `trialEndsAt` is in the future — an
   *     expired trial that Stripe/the trial-expiry sweep hasn't yet
   *     flipped to a terminal status is still blocked here rather than
   *     waiting for that write to land.
   *   - anything else (no subscription row at all, `past_due`,
   *     `canceled`, `incomplete`, or a `trialing` row whose trial has
   *     lapsed) -> false, with a `blockReason` naming which case.
   *
   * A MISSING subscription row is a documented, deliberate block
   * (`blockReason: 'no_subscription'`), not a silent pass. This is a
   * genuine behavior change from the pre-launch default (a tenant with no
   * subscription used to sail through with `hasEnforceablePlan: false`,
   * since there was nothing to enforce before this app sold anything) —
   * see the header comment on `EntitlementCheckResult.allowed` and
   * migration 0046's backfill, which exists specifically to comp every
   * pre-existing tenant so this change doesn't retroactively cut them off.
   */
  async checkEntitlement(tenantId: string): Promise<EntitlementCheckResult> {
    const subscription = await this.billing.getForTenant(tenantId);
    const gate = evaluateEntitlementGate(subscription);

    if (!gate.allowed) {
      return {
        allowed: false,
        blockReason: gate.blockReason,
        hasEnforceablePlan: false,
        overMessageLimit: false,
        overSpendCap: false,
        usage: null,
      };
    }

    // T17's usage-cap enforcement is unchanged below this point — it only
    // ever runs for a tenant the gate above already allowed.
    if (
      !subscription ||
      (subscription.status !== 'active' && subscription.status !== 'trialing')
    ) {
      // Reachable only for a comped tenant whose status is neither (e.g.
      // comped with no real subscription at all, or comped while
      // `incomplete`) — comped already granted `allowed: true` above, and
      // there is no plan-derived cap to enforce against a status that
      // was never active/trialing in Stripe's own terms.
      return {
        allowed: true,
        blockReason: null,
        hasEnforceablePlan: false,
        overMessageLimit: false,
        overSpendCap: false,
        usage: null,
      };
    }

    const [planRow] = await this.persistence.runAdminQuery((db) =>
      db.select().from(plans).where(eq(plans.id, subscription.planId)).limit(1),
    );
    if (!planRow) {
      // Plan row deleted out from under an existing subscription — a data
      // integrity gap, not a reason to silently degrade a paying tenant.
      return {
        allowed: true,
        blockReason: null,
        hasEnforceablePlan: false,
        overMessageLimit: false,
        overSpendCap: false,
        usage: null,
      };
    }

    const usage = await this.getMonthlyUsage(tenantId);

    return {
      allowed: true,
      blockReason: null,
      hasEnforceablePlan: true,
      overMessageLimit: usage.messageCount >= planRow.monthlyMessageLimit,
      overSpendCap: usage.totalCostUsd >= planRow.monthlySpendCapUsd,
      usage,
    };
  }
}

/**
 * Pure, unit-testable core of the launch-day entitlement gate — split out
 * of the async method above so the whole status/comped/trial-expiry
 * decision table can be tested without a database.
 */
export function evaluateEntitlementGate(
  subscription: Pick<
    TenantSubscriptionRecord,
    'status' | 'trialEndsAt' | 'comped'
  > | null,
):
  | { allowed: true; blockReason: null }
  | { allowed: false; blockReason: EntitlementBlockReason } {
  if (!subscription) {
    return { allowed: false, blockReason: 'no_subscription' };
  }
  if (subscription.comped) {
    return { allowed: true, blockReason: null };
  }
  if (subscription.status === 'active') {
    return { allowed: true, blockReason: null };
  }
  if (subscription.status === 'trialing') {
    const stillTrialing =
      !!subscription.trialEndsAt &&
      subscription.trialEndsAt.getTime() > Date.now();
    return stillTrialing
      ? { allowed: true, blockReason: null }
      : { allowed: false, blockReason: 'trial_expired' };
  }
  if (subscription.status === 'past_due') {
    return { allowed: false, blockReason: 'past_due' };
  }
  if (subscription.status === 'canceled') {
    return { allowed: false, blockReason: 'canceled' };
  }
  // 'incomplete', or any future status this app doesn't yet recognize —
  // fail closed rather than assume a new/unknown status is safe to allow.
  return { allowed: false, blockReason: 'incomplete' };
}
