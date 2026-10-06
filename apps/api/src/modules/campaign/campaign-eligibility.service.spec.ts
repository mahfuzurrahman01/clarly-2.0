import type { AppConfigService, AppLoggerService, Clock } from '../core';
import type { UsageService } from '../billing/usage.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { WhatsappHealthReconcileService } from '../whatsapp/health/whatsapp-health.module';
import {
  CampaignEligibilityService,
  REVOCABLE_BLOCK_REASONS,
  describeBlocks,
  type EligibilityBlock,
  type EligibilityBlockReason,
} from './campaign-eligibility.service';

const NOW = new Date('2026-09-21T12:00:00.000Z');

/** A number that passes every single condition. Each test blanks exactly one. */
function healthyRow(overrides: Record<string, unknown> = {}) {
  return {
    connectionState: 'active',
    connectionError: null,
    messagingHealth: 'AVAILABLE',
    qualityRating: 'GREEN',
    paymentMethodAttached: true,
    messagingLimitTier: 'TIER_10K',
    businessVerificationStatus: 'verified',
    wabaAccountReviewStatus: 'APPROVED',
    wabaId: 'waba-1',
    lastHealthCheckAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    ...overrides,
  };
}

function makeHarness(
  row: Record<string, unknown> | null = healthyRow(),
  entitlement: Record<string, unknown> = {
    allowed: true,
    overMessageLimit: false,
    blockReason: null,
  },
) {
  let currentRow = row;
  const tenantContext = {
    withTenantTx: jest.fn(() =>
      Promise.resolve(currentRow ? [currentRow] : []),
    ),
  } as unknown as TenantContextService;

  const usage = {
    checkEntitlement: jest.fn().mockResolvedValue(entitlement),
  } as unknown as UsageService;

  const health = {
    reconcileNumber: jest.fn().mockResolvedValue('checked'),
  } as unknown as WhatsappHealthReconcileService;

  const config = {
    campaignTierHeadroomPct: 90,
    campaignMaxWindowSpan: 3,
  } as unknown as AppConfigService;

  const clock = { now: () => NOW } as unknown as Clock;
  const logger = {
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as AppLoggerService;

  const service = new CampaignEligibilityService(
    tenantContext,
    usage,
    health,
    config,
    clock,
    logger,
  );
  return {
    service,
    tenantContext,
    usage,
    health,
    logger,
    setRow: (next: Record<string, unknown> | null) => {
      currentRow = next;
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 't-1',
    phoneNumberId: 'pn-1',
    category: 'MARKETING' as const,
    recipientCount: 100,
    templateWabaId: 'waba-1',
    ...overrides,
  };
}

async function reasonsFor(
  row: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
  entitlement?: Record<string, unknown>,
): Promise<EligibilityBlockReason[]> {
  const { service } = makeHarness(row, entitlement);
  const result = await service.check(input(overrides));
  return result.blocks.map((block) => block.reason);
}

describe('CampaignEligibilityService (F19 D4 / plan D15c)', () => {
  it('passes a fully healthy, verified, funded, in-tier number', async () => {
    const { service } = makeHarness();
    await expect(service.check(input())).resolves.toEqual({
      eligible: true,
      blocks: [],
    });
  });

  it('404s a number this tenant has not connected', async () => {
    await expect(reasonsFor(null)).resolves.toEqual(['number_not_found']);
  });

  it('blocks a number that is not active, quoting the stored connection error', async () => {
    const { service } = makeHarness(
      healthyRow({
        connectionState: 'reconnect_required',
        connectionError: 'Meta refused the token. Reconnect the number.',
      }),
    );
    const result = await service.check(input());
    expect(result.eligible).toBe(false);
    expect(result.blocks[0]).toEqual({
      reason: 'number_not_active',
      message: 'Meta refused the token. Reconnect the number.',
    });
  });

  it('blocks LIMITED and BLOCKED messaging health', async () => {
    await expect(
      reasonsFor(healthyRow({ messagingHealth: 'LIMITED' })),
    ).resolves.toEqual(['messaging_restricted']);
    await expect(
      reasonsFor(healthyRow({ messagingHealth: 'BLOCKED' })),
    ).resolves.toEqual(['messaging_restricted']);
  });

  it('blocks a RED quality rating', async () => {
    await expect(
      reasonsFor(healthyRow({ qualityRating: 'RED' })),
    ).resolves.toEqual(['quality_red']);
  });

  it('blocks a WABA with no payment method', async () => {
    await expect(
      reasonsFor(healthyRow({ paymentMethodAttached: false })),
    ).resolves.toEqual(['no_payment_method']);
  });

  it('blocks TIER_NOT_SET as an unknown tier', async () => {
    await expect(
      reasonsFor(healthyRow({ messagingLimitTier: 'TIER_NOT_SET' })),
    ).resolves.toEqual(['tier_unknown']);
  });

  it('blocks a recipient count beyond tier allowance x window span', async () => {
    // TIER_50 at 90% headroom = 45; x3 windows = 135.
    await expect(
      reasonsFor(healthyRow({ messagingLimitTier: 'TIER_50' }), {
        recipientCount: 136,
      }),
    ).resolves.toEqual(['over_tier_span']);
    await expect(
      reasonsFor(healthyRow({ messagingLimitTier: 'TIER_50' }), {
        recipientCount: 135,
      }),
    ).resolves.toEqual([]);
  });

  it('never applies the tier span to TIER_UNLIMITED', async () => {
    await expect(
      reasonsFor(healthyRow({ messagingLimitTier: 'TIER_UNLIMITED' }), {
        recipientCount: 50_000,
      }),
    ).resolves.toEqual([]);
  });

  it('blocks an unverified business for MARKETING but not for UTILITY', async () => {
    const row = healthyRow({ businessVerificationStatus: 'not_verified' });
    await expect(reasonsFor(row)).resolves.toEqual(['business_not_verified']);
    await expect(reasonsFor(row, { category: 'UTILITY' })).resolves.toEqual([]);
  });

  it('blocks when billing blocks, and when the tenant is over its message limit', async () => {
    await expect(
      reasonsFor(
        healthyRow(),
        {},
        {
          allowed: false,
          blockReason: 'subscription_past_due',
          overMessageLimit: false,
        },
      ),
    ).resolves.toEqual(['billing_blocked']);
    await expect(
      reasonsFor(
        healthyRow(),
        {},
        {
          allowed: true,
          blockReason: null,
          overMessageLimit: true,
        },
      ),
    ).resolves.toEqual(['billing_blocked']);
  });

  describe('every unknown value fails CLOSED', () => {
    const nullable: Array<[string, EligibilityBlockReason]> = [
      ['messagingHealth', 'messaging_restricted'],
      ['qualityRating', 'quality_red'],
      ['paymentMethodAttached', 'no_payment_method'],
      ['messagingLimitTier', 'tier_unknown'],
      ['businessVerificationStatus', 'verification_unknown'],
    ];

    it.each(nullable)('null %s blocks with %s', async (field, reason) => {
      const reasons = await reasonsFor(healthyRow({ [field]: null }));
      expect(reasons).toContain(reason);
    });

    it('a number never health-checked at all is blocked on every unknown, not waved through', async () => {
      const reasons = await reasonsFor(
        healthyRow({
          messagingHealth: null,
          qualityRating: null,
          paymentMethodAttached: null,
          messagingLimitTier: null,
          businessVerificationStatus: null,
          lastHealthCheckAt: null,
        }),
      );
      expect(reasons).toEqual(
        expect.arrayContaining([
          'messaging_restricted',
          'quality_red',
          'no_payment_method',
          'tier_unknown',
          'verification_unknown',
        ]),
      );
    });
  });

  it('returns EVERY block, not just the first, so a merchant fixes it all in one trip', async () => {
    const reasons = await reasonsFor(
      healthyRow({
        connectionState: 'restricted',
        messagingHealth: 'BLOCKED',
        qualityRating: 'RED',
        paymentMethodAttached: false,
      }),
    );
    expect(reasons.length).toBeGreaterThanOrEqual(4);
  });

  describe('stale health snapshots', () => {
    it('triggers an on-demand read when the snapshot is older than 24h', async () => {
      const { service, health } = makeHarness(
        healthyRow({
          lastHealthCheckAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        }),
      );
      await service.check(input());
      expect(health.reconcileNumber).toHaveBeenCalledWith({
        tenantId: 't-1',
        phoneNumberId: 'pn-1',
      });
    });

    it('triggers an on-demand read when the number was never checked', async () => {
      const { service, health } = makeHarness(
        healthyRow({ lastHealthCheckAt: null }),
      );
      await service.check(input());
      expect(health.reconcileNumber).toHaveBeenCalled();
    });

    it('does not re-read a snapshot taken within 24h', async () => {
      const { service, health } = makeHarness();
      await service.check(input());
      expect(health.reconcileNumber).not.toHaveBeenCalled();
    });

    it('falls back to the stored snapshot when the on-demand read fails', async () => {
      const { service, health, logger } = makeHarness(
        healthyRow({ lastHealthCheckAt: null }),
      );
      (health.reconcileNumber as jest.Mock).mockRejectedValue(
        new Error('Meta is down'),
      );
      await expect(service.check(input())).resolves.toEqual({
        eligible: true,
        blocks: [],
      });
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('recheck (the per-batch revocable subset)', () => {
    it('keeps only revocable reasons', async () => {
      const { service } = makeHarness(
        healthyRow({
          paymentMethodAttached: false, // not revocable
          qualityRating: 'RED', // revocable
        }),
      );
      const result = await service.recheck(input());
      expect(result.blocks.map((b) => b.reason)).toEqual(['quality_red']);
    });

    it('passes when the only remaining problems are launch-time facts', async () => {
      const { service } = makeHarness(
        healthyRow({ messagingLimitTier: 'TIER_50' }),
      );
      await expect(
        service.recheck(input({ recipientCount: 100_000 })),
      ).resolves.toEqual({ eligible: true, blocks: [] });
    });

    it('does not re-decide the template<->WABA match mid-send (a launch-time fact)', async () => {
      const { service } = makeHarness(healthyRow({ wabaId: 'waba-other' }));
      await expect(service.recheck(input())).resolves.toEqual({
        eligible: true,
        blocks: [],
      });
    });

    it('names a revocable set that is a subset of the full reason list', () => {
      for (const reason of REVOCABLE_BLOCK_REASONS) {
        expect(typeof reason).toBe('string');
      }
      expect(REVOCABLE_BLOCK_REASONS).toContain('billing_blocked');
      expect(REVOCABLE_BLOCK_REASONS).not.toContain('over_tier_span');
      expect(REVOCABLE_BLOCK_REASONS).not.toContain('no_payment_method');
    });
  });

  // D2 bullet 5. Meta scopes template approval to a WABA, so a template
  // approved on one account is not sendable from a number on another. The
  // check was unenforceable until message_templates.waba_id existed
  // (migration 0062); these cases are the contract it now has.
  describe('template <-> WABA match (D2 bullet 5)', () => {
    it('passes when the template and the sending number are on the same WABA', async () => {
      await expect(
        reasonsFor(healthyRow({ wabaId: 'waba-1' }), {
          templateWabaId: 'waba-1',
        }),
      ).resolves.toEqual([]);
    });

    it('blocks a template approved on a different WABA, naming both', async () => {
      const { service } = makeHarness(healthyRow({ wabaId: 'waba-1' }));
      const result = await service.check(input({ templateWabaId: 'waba-2' }));
      expect(result.eligible).toBe(false);
      const block = (result.blocks as EligibilityBlock[]).find(
        (candidate) => candidate.reason === 'template_waba_mismatch',
      );
      expect(block?.message).toContain('waba-2');
      expect(block?.message).toContain('waba-1');
    });

    it('blocks a template with no WABA recorded — fail closed, never waved through', async () => {
      await expect(
        reasonsFor(healthyRow(), { templateWabaId: null }),
      ).resolves.toEqual(['template_waba_mismatch']);
    });

    it('tells a merchant to re-sync when the TEMPLATE is the unknown side', async () => {
      const { service } = makeHarness(healthyRow());
      const result = await service.check(input({ templateWabaId: null }));
      expect(result.blocks[0].message).toMatch(/Re-sync your templates/);
    });

    it('blocks when the NUMBER has no WABA recorded, and says to run a health check', async () => {
      const { service } = makeHarness(healthyRow({ wabaId: null }));
      const result = await service.check(input({ templateWabaId: 'waba-1' }));
      expect(result.blocks.map((block) => block.reason)).toEqual([
        'template_waba_mismatch',
      ]);
      expect(result.blocks[0].message).toMatch(/health check/);
    });

    it('blocks once, not twice, when NEITHER side has a WABA', async () => {
      await expect(
        reasonsFor(healthyRow({ wabaId: null }), { templateWabaId: null }),
      ).resolves.toEqual(['template_waba_mismatch']);
    });

    it('reports the mismatch alongside every other block, not instead of them', async () => {
      await expect(
        reasonsFor(healthyRow({ wabaId: 'waba-1', qualityRating: 'RED' }), {
          templateWabaId: 'waba-2',
        }),
      ).resolves.toEqual(['quality_red', 'template_waba_mismatch']);
    });
  });

  it('describeBlocks joins the merchant-facing messages', () => {
    expect(
      describeBlocks([
        { reason: 'quality_red', message: 'A.' },
        { reason: 'billing_blocked', message: 'B.' },
      ]),
    ).toBe('A. B.');
    expect(describeBlocks([])).toBe('');
  });
});
