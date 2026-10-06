import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';

export const monthlyUsageResultSchema = z.object({
  tenantId: z.string().uuid(),
  periodStart: isoTimestamp(),
  periodEnd: isoTimestamp(),
  messageCount: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  totalCostUsd: z.number(),
});

export type MonthlyUsageResult = z.infer<typeof monthlyUsageResultSchema>;

export class MonthlyUsageResultDto extends createZodDto(
  monthlyUsageResultSchema,
) {}

/**
 * Launch billing backend (Lane A): why a tenant is or isn't allowed to
 * receive an AI reply right now. Distinct from `hasEnforceablePlan`/
 * `overMessageLimit`/`overSpendCap` below (T17's usage-cap enforcement,
 * unchanged) — `allowed`/`blockReason` is the NEW, stricter gate:
 * comped/active/mid-trial tenants pass it; a tenant with no subscription
 * row, an expired trial, or a lapsed (`past_due`/`canceled`/`incomplete`)
 * subscription does not, regardless of usage.
 */
export type EntitlementBlockReason =
  'no_subscription' | 'trial_expired' | 'past_due' | 'canceled' | 'incomplete';

/** Internal only — consumed by the entitlement check inside the respond path, never returned over HTTP, so it stays a plain interface with no OpenAPI model. */
export interface EntitlementCheckResult {
  /**
   * The billing-backend launch gate (Lane A). `comped` always allows;
   * `active` always allows; `trialing` allows only while
   * `trialEndsAt > now()`. Everything else — no row at all, an expired
   * trial, `past_due`, `canceled`, `incomplete` — is blocked.
   *
   * A missing subscription row is an EXPLICIT block, not a silent pass:
   * pre-launch this was `hasEnforceablePlan: false` -> "nothing to
   * enforce, let it through", which was correct before this app ever sold
   * a subscription. Once billing is live, "no row" almost always means
   * "never signed up" or "the local-trial row got deleted", not "billing
   * isn't turned on for this environment" — a distinction the launch-day
   * backfill migration (0046) exists specifically to draw a line under,
   * by comping every tenant that predates this check.
   */
  allowed: boolean;
  /** Set only when `allowed` is false — why. */
  blockReason: EntitlementBlockReason | null;
  /** False when the tenant has no active/trialing subscription at all — nothing to enforce against, so the caller should never degrade a tenant with no billing set up. Usage-cap enforcement only; independent of `allowed` above. */
  hasEnforceablePlan: boolean;
  overMessageLimit: boolean;
  overSpendCap: boolean;
  usage: MonthlyUsageResult | null;
}
