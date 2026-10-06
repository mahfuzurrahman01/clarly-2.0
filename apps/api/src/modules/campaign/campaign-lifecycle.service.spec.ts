// F19 (D3, D8, D9): CampaignService's lifecycle half — schedule, pause,
// resume, cancel.
//
// `create()` and the template gate are covered in campaign.service.spec.ts;
// this file is about the state machine and the two things that make it safe:
//
//   1. every arrow that starts a send re-runs BOTH revocable gates, and
//   2. cancel terminates every remaining recipient in the same transaction
//      that marks the campaign canceled — exit criterion 2 as a database
//      fact rather than an intention.
import type { AppConfigService, Clock } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { MessageTemplateService } from '../templates/message-template.service';
import type { CampaignEligibilityService } from './campaign-eligibility.service';
import type { CampaignSendSchedulerService } from './campaign-send.scheduler.service';
import {
  CampaignNotEligibleError,
  CampaignService,
  CampaignSpendCapExceededError,
  CampaignStateError,
} from './campaign.service';
import { CampaignTemplateGateError } from './campaign-template-gate';
import { MARKETING_OPT_OUT_FRAGMENT } from './marketing-opt-out-fragment';
import type { SegmentResolverService } from './segment-resolver.service';
import type { SegmentService } from './segment.service';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';

jest.mock('../notifications/notification-resolution', () => ({
  markEntityNotificationsRead: jest.fn().mockResolvedValue(1),
}));

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';
const NOW = new Date('2026-09-22T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
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
    status: 'draft',
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    recipientCount: 0,
    estimatedCostUsd: 0,
    spendCapUsd: 50,
    spentUsd: 0,
    pauseReason: null,
    failureReason: null,
    createdBy: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(
  opts: {
    status?: string;
    spendCapUsd?: number;
    spentUsd?: number;
    previewCount?: number;
    templateCategory?: string | null;
    templateBody?: string;
    eligibilityBlocks?: { reason: string; message: string }[];
  } = {},
) {
  const current = row({
    status: opts.status ?? 'draft',
    spendCapUsd: opts.spendCapUsd ?? 50,
    spentUsd: opts.spentUsd ?? 0,
  });

  /** Every `.set()` payload the service issued, in call order. */
  const updates: Record<string, unknown>[] = [];

  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([current]) }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        const result = {
          returning: () => Promise.resolve([{ ...current, ...values }]),
          then: (...args: unknown[]) =>
            (Promise.resolve([]) as unknown as Promise<unknown>).then(
              ...(args as [never, never]),
            ),
        };
        return { where: () => result };
      },
    }),
  });

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => fn(makeTx()));

  const templates = {
    require: jest.fn().mockResolvedValue({
      id: current.templateId,
      kind: 'whatsapp_template',
      name: 'spring_sale',
      language: 'en',
      category:
        opts.templateCategory === undefined
          ? 'MARKETING'
          : opts.templateCategory,
      body: opts.templateBody ?? `Hi {{1}}. ${MARKETING_OPT_OUT_FRAGMENT}`,
      variables: [{ position: 1, label: 'Name', example: 'Sam' }],
      approvalStatus: 'approved',
      approvalDetail: null,
    }),
  } as unknown as MessageTemplateService;

  const segments = {
    require: jest.fn().mockResolvedValue({
      id: current.segmentId,
      definition: { kind: 'never_ordered' },
    }),
  } as unknown as SegmentService;

  const preview = jest
    .fn()
    .mockResolvedValue({ count: opts.previewCount ?? 10, resolvedAt: NOW });
  const resolver = { preview } as unknown as SegmentResolverService;

  const check = jest
    .fn()
    .mockResolvedValue(
      opts.eligibilityBlocks
        ? { eligible: false, blocks: opts.eligibilityBlocks }
        : { eligible: true, blocks: [] },
    );
  const eligibility = { check } as unknown as CampaignEligibilityService;

  const scheduleLaunch = jest.fn().mockResolvedValue(undefined);
  const cancelScheduledLaunch = jest.fn().mockResolvedValue(undefined);
  const enqueueBatch = jest.fn().mockResolvedValue(undefined);
  const sendScheduler = {
    scheduleLaunch,
    cancelScheduledLaunch,
    enqueueBatch,
  } as unknown as CampaignSendSchedulerService;

  const service = new CampaignService(
    { withTenantTx } as unknown as TenantContextService,
    templates,
    segments,
    eligibility,
    resolver,
    sendScheduler,
    {
      campaignDefaultSpendCapUsd: 50,
      campaignMaxRecipients: 50_000,
    } as unknown as AppConfigService,
    { now: () => NOW } as unknown as Clock,
  );

  return {
    service,
    updates,
    scheduleLaunch,
    cancelScheduledLaunch,
    enqueueBatch,
    preview,
    check,
  };
}

describe('CampaignService.schedule (D8)', () => {
  it('moves a draft to scheduled, stores the estimate and queues the launch', async () => {
    const h = harness();
    const at = new Date(NOW.getTime() + 3_600_000);

    const result = await h.service.schedule(TENANT, CAMPAIGN, at);

    expect(result.status).toBe('scheduled');
    expect(h.updates[0]).toMatchObject({
      status: 'scheduled',
      scheduledAt: at,
    });
    expect(h.updates[0].estimatedCostUsd).toBeGreaterThan(0);
    expect(h.scheduleLaunch).toHaveBeenCalledWith(TENANT, CAMPAIGN, at);
  });

  it('treats a null time as "send now"', async () => {
    const h = harness();
    await h.service.schedule(TENANT, CAMPAIGN, null);
    expect(h.scheduleLaunch).toHaveBeenCalledWith(TENANT, CAMPAIGN, null);
  });

  it('refuses a campaign that is already sending', async () => {
    const h = harness({ status: 'sending' });
    await expect(
      h.service.schedule(TENANT, CAMPAIGN, null),
    ).rejects.toBeInstanceOf(CampaignStateError);
  });

  it('refuses — and queues nothing — when the estimate exceeds the cap, naming all three numbers', async () => {
    const h = harness({ previewCount: 10_000, spendCapUsd: 5 });

    const caught = await h.service
      .schedule(TENANT, CAMPAIGN, null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(CampaignSpendCapExceededError);
    const body = (caught as CampaignSpendCapExceededError).getResponse() as {
      estimatedCostUsd: number;
      spendCapUsd: number;
      requiredCapUsd: number;
    };
    expect(body.spendCapUsd).toBe(5);
    expect(body.requiredCapUsd).toBe(body.estimatedCostUsd);
    expect(h.scheduleLaunch).not.toHaveBeenCalled();
  });

  it('refuses with the FULL eligibility block list, so a merchant fixes everything in one trip (D4)', async () => {
    const h = harness({
      eligibilityBlocks: [
        { reason: 'quality_red', message: 'Meta rates this number RED.' },
        { reason: 'no_payment_method', message: 'No payment method.' },
      ],
    });

    const caught = await h.service
      .schedule(TENANT, CAMPAIGN, null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(CampaignNotEligibleError);
    const body = (caught as CampaignNotEligibleError).getResponse() as {
      blocks: { reason: string }[];
    };
    expect(body.blocks.map((block) => block.reason)).toEqual([
      'quality_red',
      'no_payment_method',
    ]);
    expect(h.scheduleLaunch).not.toHaveBeenCalled();
  });

  it('refuses a MARKETING template with no opt-out instruction in its approved body', async () => {
    const h = harness({ templateBody: 'Hi {{1}}, sale is on.' });

    await expect(
      h.service.schedule(TENANT, CAMPAIGN, null),
    ).rejects.toBeInstanceOf(CampaignTemplateGateError);
    expect(h.scheduleLaunch).not.toHaveBeenCalled();
  });
});

describe('CampaignService.pause (D8)', () => {
  it('pauses a sending campaign with an explicit manual reason', async () => {
    const h = harness({ status: 'sending' });
    const result = await h.service.pause(TENANT, CAMPAIGN);

    expect(result.status).toBe('paused_manual');
    expect(h.updates[0].pauseReason).toMatch(/console/i);
  });

  it('un-schedules a campaign that has not launched yet', async () => {
    const h = harness({ status: 'scheduled' });
    await h.service.pause(TENANT, CAMPAIGN);
    expect(h.cancelScheduledLaunch).toHaveBeenCalledWith(CAMPAIGN);
  });

  it('refuses to pause a completed campaign', async () => {
    const h = harness({ status: 'completed' });
    await expect(h.service.pause(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
      CampaignStateError,
    );
  });
});

describe('CampaignService.resume (D3)', () => {
  it.each([
    'paused_spend_cap',
    'paused_template',
    'paused_manual',
    'paused_eligibility',
  ])('resumes from %s, re-running the gates first', async (status) => {
    const h = harness({ status });
    const result = await h.service.resume(TENANT, CAMPAIGN);

    expect(h.check).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('sending');
    expect(h.updates[0].pauseReason).toBeNull();
    // Resumes the SEND, not the launch — re-launching would re-snapshot.
    expect(h.enqueueBatch).toHaveBeenCalled();
  });

  it('refuses to resume a campaign that was never paused', async () => {
    const h = harness({ status: 'sending' });
    await expect(h.service.resume(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
      CampaignStateError,
    );
  });

  it('counts money already spent against the cap, so a resume cannot overspend what is left', async () => {
    const h = harness({
      status: 'paused_spend_cap',
      spentUsd: 49,
      spendCapUsd: 50,
      previewCount: 1_000,
    });

    await expect(h.service.resume(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
      CampaignSpendCapExceededError,
    );
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('refuses to resume onto a number Meta has since restricted', async () => {
    const h = harness({
      status: 'paused_eligibility',
      eligibilityBlocks: [
        { reason: 'messaging_restricted', message: 'Meta reports LIMITED.' },
      ],
    });

    await expect(h.service.resume(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
      CampaignNotEligibleError,
    );
  });
});

describe('CampaignService.cancel (exit criterion 2)', () => {
  it('terminates every pending and sending recipient with an explicit reason', async () => {
    const h = harness({ status: 'sending' });
    const result = await h.service.cancel(TENANT, CAMPAIGN);

    expect(h.updates[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'canceled',
    });
    expect(h.updates[1]).toMatchObject({ status: 'canceled' });
    expect(result.status).toBe('canceled');
  });

  it('removes a launch that has not fired', async () => {
    const h = harness({ status: 'scheduled' });
    await h.service.cancel(TENANT, CAMPAIGN);
    expect(h.cancelScheduledLaunch).toHaveBeenCalledWith(CAMPAIGN);
  });

  it('cancels a draft too, without needing it to have been scheduled', async () => {
    const h = harness({ status: 'draft' });
    await expect(h.service.cancel(TENANT, CAMPAIGN)).resolves.toMatchObject({
      status: 'canceled',
    });
  });

  it.each(['completed', 'canceled', 'failed'])(
    'refuses to cancel a %s campaign — terminal means terminal',
    async (status) => {
      const h = harness({ status });
      await expect(h.service.cancel(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
        CampaignStateError,
      );
    },
  );
});

describe('CampaignService.update (D8)', () => {
  it('edits a draft', async () => {
    const h = harness({ status: 'draft' });
    const result = await h.service.update(TENANT, CAMPAIGN, {
      name: 'Autumn sale',
    });
    expect(result.name).toBe('Autumn sale');
  });

  it.each(['scheduled', 'sending', 'completed'])(
    'refuses to edit a %s campaign — it is a historical record',
    async (status) => {
      const h = harness({ status });
      await expect(
        h.service.update(TENANT, CAMPAIGN, { name: 'x' }),
      ).rejects.toBeInstanceOf(CampaignStateError);
    },
  );
});

describe('CampaignService send-path transitions', () => {
  it('markSending stores the snapshot count and the start time', async () => {
    const h = harness({ status: 'scheduled' });
    await h.service.markSending(TENANT, CAMPAIGN, 1_234);

    expect(h.updates[0]).toMatchObject({
      status: 'sending',
      recipientCount: 1_234,
      startedAt: NOW,
    });
  });

  it('markPaused leaves recipients alone — pausing is not cancelling', async () => {
    const h = harness({ status: 'sending' });
    await h.service.markPaused(
      TENANT,
      CAMPAIGN,
      'paused_template',
      'Template rejected',
    );

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      status: 'paused_template',
      pauseReason: 'Template rejected',
    });
  });

  it('markFailed keeps the reason verbatim', async () => {
    const h = harness({ status: 'scheduled' });
    await h.service.markFailed(TENANT, CAMPAIGN, 'Meta says no');
    expect(h.updates[0]).toMatchObject({
      status: 'failed',
      failureReason: 'Meta says no',
    });
  });
});

// QA 2026-10-05: "Campaign X paused" is stale once the merchant has resumed or
// canceled it.
describe('CampaignService — retiring the pause notification', () => {
  const resolveMock = jest.mocked(markEntityNotificationsRead);
  beforeEach(() => resolveMock.mockClear());

  const expected = {
    tenantId: TENANT,
    entityType: 'campaign',
    entityIds: [CAMPAIGN],
    kinds: ['campaign_paused'],
    readAt: NOW,
  };

  it('retires it when the campaign is resumed', async () => {
    const h = harness({ status: 'paused_spend_cap' });
    await h.service.resume(TENANT, CAMPAIGN);
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), expected);
  });

  it('retires it when the campaign is canceled', async () => {
    const h = harness({ status: 'paused_template' });
    await h.service.cancel(TENANT, CAMPAIGN);
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), expected);
  });

  it('keeps it when the resume is refused — the pause still stands', async () => {
    const h = harness({
      status: 'paused_spend_cap',
      spentUsd: 49,
      spendCapUsd: 50,
      previewCount: 1_000,
    });
    await expect(h.service.resume(TENANT, CAMPAIGN)).rejects.toBeInstanceOf(
      CampaignSpendCapExceededError,
    );
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('does not touch notifications on a manual pause', async () => {
    const h = harness({ status: 'sending' });
    await h.service.pause(TENANT, CAMPAIGN);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
