// F19 (D4 / plan D15c): "volume gated on the number's messaging tier +
// tenant business verification".
//
// Returns the FULL list of blocks, not the first failure, so a merchant
// fixes everything in one trip rather than discovering a second problem
// after fixing the first.
//
// EVERY condition fails closed on null. A number whose health has never been
// read is blocked with an actionable message, never waved through — F24's
// plaintext-token and dead-signature bugs both came from an unpopulated
// value being treated as benign.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppConfigService, AppLoggerService, Clock } from '../core';
import { UsageService } from '../billing/usage.service';
import { whatsappNumbers } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { WhatsappHealthReconcileService } from '../whatsapp/health/whatsapp-health.module';
import { campaignDailyAllowance } from './campaign-rate-limiter.service';

const CONTEXT = 'CampaignEligibilityService';

/** How old a health snapshot may be before a check re-reads it from Meta on demand. */
export const HEALTH_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const ELIGIBILITY_BLOCK_REASONS = [
  'number_not_found',
  'number_not_active',
  'messaging_restricted',
  'quality_red',
  'no_payment_method',
  'tier_unknown',
  'over_tier_span',
  'business_not_verified',
  'verification_unknown',
  'billing_blocked',
  'template_waba_mismatch',
] as const;
export type EligibilityBlockReason = (typeof ELIGIBILITY_BLOCK_REASONS)[number];

/**
 * The subset D4 re-checks once per batch during a send, because Meta can
 * revoke any of them mid-campaign. The rest (payment method, tier span,
 * template<->WABA) are launch-time facts that cannot change the answer for
 * an in-flight send: which account approved a template is not something Meta
 * revokes, and a campaign cannot change its sending number once it is
 * `sending`. If a re-sync clears the template's WABA mid-send, the D2
 * template gate the runner already runs per batch is what catches it.
 */
export const REVOCABLE_BLOCK_REASONS: readonly EligibilityBlockReason[] = [
  'number_not_found',
  'number_not_active',
  'messaging_restricted',
  'quality_red',
  'business_not_verified',
  'verification_unknown',
  'billing_blocked',
];

export interface EligibilityBlock {
  reason: EligibilityBlockReason;
  /** What the merchant must actually do, in words they can act on. */
  message: string;
}

export type EligibilityResult =
  | { eligible: true; blocks: [] }
  | { eligible: false; blocks: EligibilityBlock[] };

export interface EligibilityCheckInput {
  tenantId: string;
  phoneNumberId: string;
  /**
   * D4: a MARKETING campaign requires business verification; a UTILITY one
   * (F26's courier updates share this sender) does not, matching Meta's own
   * rule that an unverified business may send utility traffic.
   */
  category: 'MARKETING' | 'UTILITY';
  /** How many recipients the send must get through — checked against tier × CAMPAIGN_MAX_WINDOW_SPAN. */
  recipientCount: number;
  /**
   * D2 bullet 5: the WABA the campaign's template is approved on
   * (`message_templates.waba_id`). Must equal the sending number's
   * `waba_id`, because Meta scopes template approval to the account.
   *
   * Null means "we do not know which account approved it" — a template
   * synced before migration 0062, or one two of the tenant's accounts both
   * report. It BLOCKS, like every other unknown in this service.
   */
  templateWabaId: string | null;
}

interface NumberHealthRow {
  connectionState: string;
  connectionError: string | null;
  messagingHealth: string | null;
  qualityRating: string | null;
  paymentMethodAttached: boolean | null;
  messagingLimitTier: string | null;
  businessVerificationStatus: string | null;
  wabaAccountReviewStatus: string | null;
  wabaId: string | null;
  lastHealthCheckAt: Date | null;
}

@Injectable()
export class CampaignEligibilityService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly usage: UsageService,
    private readonly health: WhatsappHealthReconcileService,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
  ) {}

  /** The full D4 gate. Called at launch and at resume. */
  async check(input: EligibilityCheckInput): Promise<EligibilityResult> {
    const blocks = await this.collectBlocks(input);
    return blocks.length === 0
      ? { eligible: true, blocks: [] }
      : { eligible: false, blocks };
  }

  /**
   * The revocable subset, re-run once per batch during a send. Same reads,
   * filtered — deliberately not a second implementation of the rules.
   */
  async recheck(input: EligibilityCheckInput): Promise<EligibilityResult> {
    const blocks = (await this.collectBlocks(input)).filter((block) =>
      REVOCABLE_BLOCK_REASONS.includes(block.reason),
    );
    return blocks.length === 0
      ? { eligible: true, blocks: [] }
      : { eligible: false, blocks };
  }

  /**
   * The two Meta-owned values the SENDER needs per batch — the tier its 24h
   * allowance is derived from, and the quality rating that halves it.
   *
   * Deliberately the same stored row `check()` decides from, rather than a
   * second read with its own freshness rules: the limiter and the gate must
   * never be able to disagree about what tier a number is on.
   */
  async tierSnapshot(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<{
    messagingLimitTier: string | null;
    qualityRating: string | null;
  } | null> {
    const row = await this.read(tenantId, phoneNumberId);
    if (!row) return null;
    return {
      messagingLimitTier: row.messagingLimitTier,
      qualityRating: row.qualityRating,
    };
  }

  private async collectBlocks(
    input: EligibilityCheckInput,
  ): Promise<EligibilityBlock[]> {
    const row = await this.readFresh(input.tenantId, input.phoneNumberId);
    if (!row) {
      return [
        {
          reason: 'number_not_found',
          message: `WhatsApp number ${input.phoneNumberId} is not connected to this workspace.`,
        },
      ];
    }

    const blocks: EligibilityBlock[] = [];

    // 1. connection state
    if (row.connectionState !== 'active') {
      blocks.push({
        reason: 'number_not_active',
        message:
          row.connectionError ??
          `This number is "${row.connectionState}". Reconnect it before sending a campaign.`,
      });
    }

    // 2. messaging health — LIMITED and BLOCKED both refuse, null fails closed
    if (row.messagingHealth !== 'AVAILABLE') {
      blocks.push({
        reason: 'messaging_restricted',
        message:
          row.messagingHealth == null
            ? "Meta has never reported this number's messaging health. Run a health check before sending a campaign."
            : `Meta reports this number's messaging as "${row.messagingHealth}". It cannot start a broadcast until that clears.`,
      });
    }

    // 3. quality rating — RED refuses; null fails closed
    if (row.qualityRating == null) {
      blocks.push({
        reason: 'quality_red',
        message:
          'This number has no quality rating from Meta yet. Run a health check before sending a campaign.',
      });
    } else if (row.qualityRating === 'RED') {
      blocks.push({
        reason: 'quality_red',
        message:
          'Meta rates this number RED. A broadcast now risks losing the number entirely — improve quality first.',
      });
    }

    // 4. payment method — Meta bills the tenant's own WABA
    if (row.paymentMethodAttached !== true) {
      blocks.push({
        reason: 'no_payment_method',
        message:
          'No payment method is attached to this WhatsApp Business Account. Meta bills your WABA for each campaign message, so add one in Meta Business Manager.',
      });
    }

    // 5. tier + span
    const allowance = campaignDailyAllowance(
      row.messagingLimitTier,
      row.qualityRating,
      this.config.campaignTierHeadroomPct,
    );
    if (allowance === undefined) {
      blocks.push({
        reason: 'tier_unknown',
        message:
          'Meta has not reported a messaging limit tier for this number. Run a health check before sending a campaign.',
      });
    } else if (allowance !== null) {
      const maxRecipients = allowance * this.config.campaignMaxWindowSpan;
      if (input.recipientCount > maxRecipients) {
        blocks.push({
          reason: 'over_tier_span',
          message:
            `This number is on ${row.messagingLimitTier} (${allowance} campaign messages per 24h after headroom). ` +
            `${input.recipientCount} recipients would take more than ${this.config.campaignMaxWindowSpan} days; ` +
            `the most one campaign may target is ${maxRecipients}. Narrow the segment or raise the number's tier.`,
        });
      }
    }

    // 6. business verification — MARKETING only (D4)
    if (input.category === 'MARKETING') {
      if (row.businessVerificationStatus == null) {
        blocks.push({
          reason: 'verification_unknown',
          message:
            "Meta has not reported this business's verification status. Run a health check before sending a marketing campaign.",
        });
      } else if (row.businessVerificationStatus !== 'verified') {
        blocks.push({
          reason: 'business_not_verified',
          message:
            `This business is "${row.businessVerificationStatus}" with Meta, not verified. ` +
            'Marketing broadcasts require a verified business; utility messages do not.',
        });
      }
    }

    // 7. template <-> WABA match (D2 bullet 5)
    //
    // Template approval is per-WABA: a template approved on WABA A simply
    // does not exist for a number on WABA B, and Meta rejects the send. Both
    // sides fail closed on null — an unknown WABA on either end cannot be
    // shown to match, and "cannot be shown to match" is a block here, not a
    // shrug. Re-syncing templates and running a health check populate them.
    if (input.templateWabaId == null) {
      blocks.push({
        reason: 'template_waba_mismatch',
        message:
          'This template has no WhatsApp Business Account recorded against it, so we cannot confirm the sending number is allowed to use it. ' +
          'Re-sync your templates from WhatsApp, then try again.',
      });
    } else if (row.wabaId == null) {
      blocks.push({
        reason: 'template_waba_mismatch',
        message:
          'This number has no WhatsApp Business Account recorded against it, so we cannot confirm it may send this template. Run a health check before sending a campaign.',
      });
    } else if (row.wabaId !== input.templateWabaId) {
      blocks.push({
        reason: 'template_waba_mismatch',
        message:
          `This template is approved on WhatsApp Business Account ${input.templateWabaId}, but this number sends from ${row.wabaId}. ` +
          "Meta approves templates per business account — pick a number on the template's account, or submit the template on this one.",
      });
    }

    // 8. platform entitlement — a campaign is not a way around the billing gate
    const entitlement = await this.usage.checkEntitlement(input.tenantId);
    if (!entitlement.allowed || entitlement.overMessageLimit) {
      blocks.push({
        reason: 'billing_blocked',
        message: entitlement.allowed
          ? 'This workspace is over its monthly message allowance. Upgrade the plan before sending a campaign.'
          : `This workspace's subscription blocks sending (${entitlement.blockReason ?? 'no active subscription'}).`,
      });
    }

    return blocks;
  }

  /**
   * Reads the number's stored health, refreshing it from Meta first when the
   * snapshot is older than 24h. Deciding a 40 000-message send from a
   * week-old snapshot is the same mistake as trusting stale stock.
   *
   * A failed refresh is logged, never thrown: the stored row is then used as
   * it stands, and its nulls block on their own.
   */
  private async readFresh(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<NumberHealthRow | null> {
    const row = await this.read(tenantId, phoneNumberId);
    if (!row) return null;
    if (!this.isStale(row.lastHealthCheckAt)) return row;

    try {
      await this.health.reconcileNumber({ tenantId, phoneNumberId });
    } catch (error) {
      this.logger.warn(
        `on-demand health read for number ${phoneNumberId} failed: ${
          error instanceof Error ? error.message : String(error)
        } — deciding eligibility from the stored snapshot`,
        CONTEXT,
      );
      return row;
    }
    return (await this.read(tenantId, phoneNumberId)) ?? row;
  }

  private isStale(lastHealthCheckAt: Date | null): boolean {
    if (!lastHealthCheckAt) return true;
    return (
      this.clock.now().getTime() - lastHealthCheckAt.getTime() >
      HEALTH_SNAPSHOT_MAX_AGE_MS
    );
  }

  private async read(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<NumberHealthRow | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            connectionState: whatsappNumbers.connectionState,
            connectionError: whatsappNumbers.connectionError,
            messagingHealth: whatsappNumbers.messagingHealth,
            qualityRating: whatsappNumbers.qualityRating,
            paymentMethodAttached: whatsappNumbers.paymentMethodAttached,
            messagingLimitTier: whatsappNumbers.messagingLimitTier,
            businessVerificationStatus:
              whatsappNumbers.businessVerificationStatus,
            wabaAccountReviewStatus: whatsappNumbers.wabaAccountReviewStatus,
            wabaId: whatsappNumbers.wabaId,
            lastHealthCheckAt: whatsappNumbers.lastHealthCheckAt,
          })
          .from(whatsappNumbers)
          .where(
            and(
              eq(whatsappNumbers.tenantId, tenantId),
              eq(whatsappNumbers.phoneNumberId, phoneNumberId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ?? null;
  }
}

/** One line a merchant (or an API response) can read, from a block list. */
export function describeBlocks(blocks: readonly EligibilityBlock[]): string {
  return blocks.map((block) => block.message).join(' ');
}
