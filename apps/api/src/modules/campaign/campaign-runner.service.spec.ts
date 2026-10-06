// F19 (D2, D3, D4, D9): what one queue job does, and the three ways a batch
// can end.
//
// The invariant every case here protects: NOTHING IS EVER DROPPED. A
// deferral leaves every recipient `pending` and re-queues; a pause leaves
// every remaining recipient `pending` and stops; only a send or an explicit
// skip moves a row out of `pending`.
import type { NotificationService } from '../notifications/notification.service';
import type { AppConfigService, AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { MessageTemplateService } from '../templates/message-template.service';
import type { CampaignEligibilityService } from './campaign-eligibility.service';
import type { CampaignRateLimiter } from './campaign-rate-limiter.service';
import { CampaignRunnerService } from './campaign-runner.service';
import type { CampaignSendSchedulerService } from './campaign-send.scheduler.service';
import type { CampaignSenderService } from './campaign-sender.service';
import { CampaignTemplateGateError } from './campaign-template-gate';
import {
  CampaignDeferredError,
  CampaignNotSendingError,
  CampaignPausedError,
} from './campaign.errors';
import type { CampaignRecord, CampaignService } from './campaign.service';
import { MARKETING_OPT_OUT_FRAGMENT } from './marketing-opt-out-fragment';
import type { SegmentResolverService } from './segment-resolver.service';
import type { SegmentService } from './segment.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';

function campaign(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    id: CAMPAIGN,
    tenantId: TENANT,
    name: 'Spring sale',
    segmentId: '22222222-2222-2222-2222-222222222222',
    templateId: '33333333-3333-3333-3333-333333333333',
    templateValues: [
      { type: 'customer_field', field: 'name', fallback: 'there' },
    ],
    phoneNumberId: 'pn-1',
    status: 'sending',
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    recipientCount: 3,
    estimatedCostUsd: 1,
    spendCapUsd: 50,
    spentUsd: 0,
    pauseReason: null,
    failureReason: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function harness(
  opts: {
    campaign?: Partial<CampaignRecord>;
    pendingIds?: string[];
    slotFree?: boolean;
    templateCategory?: string | null;
    templateBody?: string;
    recheckBlocks?: { reason: string; message: string }[];
    assertSendableThrows?: unknown;
    snapshotThrows?: unknown;
    senderThrows?: unknown;
  } = {},
) {
  const record = campaign(opts.campaign);
  const pendingIds = opts.pendingIds ?? ['r1', 'r2'];

  // The runner makes exactly two kinds of read: "the next batch of pending
  // ids" and "how many are still pending". Both are the same shape.
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => {
            const rows = pendingIds.map((id) => ({ id }));
            const thenable = {
              orderBy: () => ({ limit: () => Promise.resolve(rows) }),
              then: (...args: unknown[]) =>
                (Promise.resolve(rows) as unknown as Promise<unknown>).then(
                  ...(args as [never, never]),
                ),
            };
            return thenable;
          },
        }),
      }),
    }),
  );

  const require = jest.fn().mockResolvedValue(record);
  const assertSendable = opts.assertSendableThrows
    ? jest.fn().mockRejectedValue(opts.assertSendableThrows)
    : jest.fn().mockResolvedValue({ recipientCount: 3, estimatedCostUsd: 1 });
  const markSending = jest.fn().mockResolvedValue(undefined);
  const markPaused = jest.fn().mockResolvedValue(undefined);
  const markCompleted = jest.fn().mockResolvedValue(undefined);
  const markFailed = jest.fn().mockResolvedValue(undefined);
  const campaigns = {
    require,
    assertSendable,
    markSending,
    markPaused,
    markCompleted,
    markFailed,
  } as unknown as CampaignService;

  const templateRequire = jest.fn().mockResolvedValue({
    id: record.templateId,
    kind: 'whatsapp_template',
    name: 'spring_sale',
    language: 'en',
    category:
      opts.templateCategory === undefined ? 'MARKETING' : opts.templateCategory,
    body: opts.templateBody ?? `Hi {{1}}. ${MARKETING_OPT_OUT_FRAGMENT}`,
    variables: [{ position: 1, label: 'Name', example: 'Sam' }],
    approvalStatus: 'approved',
    approvalDetail: null,
  });
  const templates = {
    require: templateRequire,
  } as unknown as MessageTemplateService;

  const segments = {
    require: jest.fn().mockResolvedValue({
      id: record.segmentId,
      definition: { kind: 'never_ordered' },
    }),
  } as unknown as SegmentService;

  const snapshot = opts.snapshotThrows
    ? jest.fn().mockRejectedValue(opts.snapshotThrows)
    : jest.fn().mockResolvedValue({ recipientCount: 3 });
  const resolver = { snapshot } as unknown as SegmentResolverService;

  const recheck = jest
    .fn()
    .mockResolvedValue(
      opts.recheckBlocks
        ? { eligible: false, blocks: opts.recheckBlocks }
        : { eligible: true, blocks: [] },
    );
  const tierSnapshot = jest.fn().mockResolvedValue({
    messagingLimitTier: 'TIER_1K',
    qualityRating: 'GREEN',
  });
  const eligibility = {
    recheck,
    tierSnapshot,
  } as unknown as CampaignEligibilityService;

  const sendOne = opts.senderThrows
    ? jest.fn().mockRejectedValue(opts.senderThrows)
    : jest.fn().mockResolvedValue('sent');
  const sender = { sendOne } as unknown as CampaignSenderService;

  const acquireNumberSlot = jest
    .fn()
    .mockResolvedValue(opts.slotFree !== false);
  const releaseNumberSlot = jest.fn().mockResolvedValue(undefined);
  const limiter = {
    acquireNumberSlot,
    releaseNumberSlot,
  } as unknown as CampaignRateLimiter;

  const enqueueBatch = jest.fn().mockResolvedValue(undefined);
  const sendScheduler = {
    enqueueBatch,
  } as unknown as CampaignSendSchedulerService;

  const record_ = jest.fn().mockResolvedValue(true);
  const notifications = { record: record_ } as unknown as NotificationService;

  const service = new CampaignRunnerService(
    { withTenantTx } as unknown as TenantContextService,
    campaigns,
    templates,
    segments,
    resolver,
    eligibility,
    sender,
    limiter,
    sendScheduler,
    notifications,
    {
      campaignBatchSize: 50,
      campaignMaxRecipients: 50_000,
    } as unknown as AppConfigService,
    { log: jest.fn(), warn: jest.fn() } as unknown as AppLoggerService,
  );

  return {
    service,
    campaignRecord: record,
    assertSendable,
    markSending,
    markPaused,
    markCompleted,
    markFailed,
    snapshot,
    sendOne,
    enqueueBatch,
    acquireNumberSlot,
    releaseNumberSlot,
    notify: record_,
    recheck,
  };
}

describe('CampaignRunnerService.launch', () => {
  it('snapshots the segment, records the count and starts the first batch', async () => {
    const h = harness({ campaign: { status: 'scheduled' } });
    await h.service.launch(TENANT, CAMPAIGN);

    expect(h.snapshot).toHaveBeenCalledTimes(1);
    expect(h.markSending).toHaveBeenCalledWith(TENANT, CAMPAIGN, 3);
    expect(h.enqueueBatch).toHaveBeenCalledWith(TENANT, CAMPAIGN, 0);
  });

  it('refuses to launch a campaign that is not `scheduled`', async () => {
    const h = harness({ campaign: { status: 'canceled' } });

    await expect(h.service.launch(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
      CampaignNotSendingError,
    );
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('fails the campaign with ZERO messages sent when the launch gate refuses (D2 point 3)', async () => {
    const h = harness({
      campaign: { status: 'scheduled' },
      assertSendableThrows: new CampaignTemplateGateError(
        'Template tpl-1 is "rejected", not approved: Meta says no',
      ),
    });

    await h.service.launch(TENANT, CAMPAIGN);

    expect(h.markFailed).toHaveBeenCalledWith(
      TENANT,
      CAMPAIGN,
      expect.stringMatching(/Meta says no/),
    );
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.markSending).not.toHaveBeenCalled();
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('fails the campaign rather than half-launching it when the snapshot aborts', async () => {
    const h = harness({
      campaign: { status: 'scheduled' },
      snapshotThrows: new Error(
        'resolves to 60000 recipients, exceeding the 50000 cap',
      ),
    });

    await h.service.launch(TENANT, CAMPAIGN);

    expect(h.markFailed).toHaveBeenCalledWith(
      TENANT,
      CAMPAIGN,
      expect.stringMatching(/exceeding the 50000 cap/),
    );
    expect(h.markSending).not.toHaveBeenCalled();
  });
});

describe('CampaignRunnerService.runBatch — stopping conditions', () => {
  it('stops quietly when the campaign is no longer sending', async () => {
    const h = harness({ campaign: { status: 'paused_manual' } });

    await expect(
      h.service.runBatch(TENANT, CAMPAIGN, 0),
    ).rejects.toBeInstanceOf(CampaignNotSendingError);
    expect(h.sendOne).not.toHaveBeenCalled();
  });

  it('defers — never drops — when another campaign holds the number (D3 concurrency)', async () => {
    const h = harness({ slotFree: false });

    await expect(
      h.service.runBatch(TENANT, CAMPAIGN, 0),
    ).rejects.toBeInstanceOf(CampaignDeferredError);
    expect(h.sendOne).not.toHaveBeenCalled();
    expect(h.markPaused).not.toHaveBeenCalled();
  });

  it('completes the campaign when no pending recipients remain', async () => {
    const h = harness({ pendingIds: [] });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.markCompleted).toHaveBeenCalledWith(TENANT, CAMPAIGN);
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('chains the next batch after a full one', async () => {
    const h = harness({ pendingIds: ['r1', 'r2'] });
    await h.service.runBatch(TENANT, CAMPAIGN, 4);

    expect(h.sendOne).toHaveBeenCalledTimes(2);
    expect(h.enqueueBatch).toHaveBeenCalledWith(TENANT, CAMPAIGN, 5);
  });

  it('releases the number slot even when the batch throws', async () => {
    const h = harness({
      senderThrows: new CampaignDeferredError(1_000, 'throughput'),
    });

    await expect(
      h.service.runBatch(TENANT, CAMPAIGN, 0),
    ).rejects.toBeInstanceOf(CampaignDeferredError);
    expect(h.releaseNumberSlot).toHaveBeenCalledWith('pn-1');
  });
});

describe('CampaignRunnerService.runBatch — the once-per-batch gates', () => {
  it('pauses on `paused_template` when the template flipped mid-send, leaving recipients pending', async () => {
    const h = harness({ templateCategory: 'AUTHENTICATION' });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.markPaused).toHaveBeenCalledWith(
      TENANT,
      CAMPAIGN,
      'paused_template',
      expect.stringMatching(/AUTHENTICATION/),
    );
    expect(h.sendOne).not.toHaveBeenCalled();
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('pauses on `paused_eligibility` for a Meta-side block that appeared mid-send', async () => {
    const h = harness({
      recheckBlocks: [
        { reason: 'quality_red', message: 'Meta rates this number RED.' },
      ],
    });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.markPaused).toHaveBeenCalledWith(
      TENANT,
      CAMPAIGN,
      'paused_eligibility',
      expect.stringMatching(/RED/),
    );
    expect(h.sendOne).not.toHaveBeenCalled();
  });

  it('pauses on `paused_spend_cap` for the billing gate — a campaign is not a way around it (D3a)', async () => {
    const h = harness({
      recheckBlocks: [
        { reason: 'billing_blocked', message: 'Subscription is past_due.' },
      ],
    });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.markPaused).toHaveBeenCalledWith(
      TENANT,
      CAMPAIGN,
      'paused_spend_cap',
      expect.stringMatching(/past_due/),
    );
  });

  it('re-checks the gates ONCE per batch, not once per message', async () => {
    const h = harness({ pendingIds: ['r1', 'r2', 'r3'] });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.recheck).toHaveBeenCalledTimes(1);
    expect(h.sendOne).toHaveBeenCalledTimes(3);
  });
});

describe('CampaignRunnerService.runBatch — the spend-cap pause (D3)', () => {
  it('stops the batch, pauses the campaign and does not chain a next batch', async () => {
    const h = harness({
      pendingIds: ['r1', 'r2', 'r3'],
      senderThrows: new CampaignPausedError(
        'spend_cap',
        'spent $49.99 of a $50.00 cap',
      ),
    });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.markPaused).toHaveBeenCalledWith(
      TENANT,
      CAMPAIGN,
      'paused_spend_cap',
      expect.stringMatching(/\$50\.00 cap/),
    );
    // It stops at the FIRST refusal — it does not keep trying the rest of
    // the batch hoping one is cheaper.
    expect(h.sendOne).toHaveBeenCalledTimes(1);
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('raises an admin notification naming how many recipients are left', async () => {
    const h = harness({
      pendingIds: ['r1', 'r2'],
      senderThrows: new CampaignPausedError('spend_cap', 'over the cap'),
    });
    await h.service.runBatch(TENANT, CAMPAIGN, 0);

    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'campaign_paused',
        entityId: CAMPAIGN,
        body: expect.stringMatching(/2 recipient\(s\) have not been messaged/),
      }),
    );
  });

  it('lets a deferral through to the processor instead of pausing', async () => {
    const h = harness({
      senderThrows: new CampaignDeferredError(60_000, '24h limit reached'),
    });

    await expect(
      h.service.runBatch(TENANT, CAMPAIGN, 0),
    ).rejects.toBeInstanceOf(CampaignDeferredError);
    expect(h.markPaused).not.toHaveBeenCalled();
    expect(h.markCompleted).not.toHaveBeenCalled();
  });
});
