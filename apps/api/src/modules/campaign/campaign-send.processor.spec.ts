// F19 (D3, D9): the worker's only job is translating the runner's three
// named outcomes into BullMQ's vocabulary. The case that matters most is the
// deferral, because a deferral that spent a retry attempt would eventually
// strand a half-sent campaign — which is a drop.
import { DelayedError, type Job } from 'bullmq';
import type { AppLoggerService } from '../core';
import type { CampaignRunnerService } from './campaign-runner.service';
import {
  CAMPAIGN_BATCH_JOB,
  CAMPAIGN_LAUNCH_JOB,
  type CampaignJobData,
} from './campaign-send.queue';
import { CampaignSendProcessor } from './campaign-send.processor';
import {
  CampaignDeferredError,
  CampaignNotSendingError,
} from './campaign.errors';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';

function makeJob(
  name: string,
  overrides: Partial<Job<CampaignJobData>> = {},
): Job<CampaignJobData> {
  return {
    id: 'job-1',
    name,
    data: { tenantId: TENANT, campaignId: CAMPAIGN, batch: 2 },
    opts: { attempts: 3 },
    attemptsMade: 0,
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Job<CampaignJobData>;
}

function harness(opts: { launchThrows?: unknown; batchThrows?: unknown } = {}) {
  const launch = opts.launchThrows
    ? jest.fn().mockRejectedValue(opts.launchThrows)
    : jest.fn().mockResolvedValue(undefined);
  const runBatch = opts.batchThrows
    ? jest.fn().mockRejectedValue(opts.batchThrows)
    : jest.fn().mockResolvedValue(undefined);
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  } as unknown as AppLoggerService;

  const processor = new CampaignSendProcessor(
    { launch, runBatch } as unknown as CampaignRunnerService,
    logger,
  );
  return { processor, launch, runBatch, logger };
}

describe('CampaignSendProcessor.process — routing', () => {
  it('routes a launch job to launch()', async () => {
    const h = harness();
    await h.processor.process(makeJob(CAMPAIGN_LAUNCH_JOB));

    expect(h.launch).toHaveBeenCalledWith(TENANT, CAMPAIGN);
    expect(h.runBatch).not.toHaveBeenCalled();
  });

  it('routes a batch job to runBatch(), carrying the batch number', async () => {
    const h = harness();
    await h.processor.process(makeJob(CAMPAIGN_BATCH_JOB));

    expect(h.runBatch).toHaveBeenCalledWith(TENANT, CAMPAIGN, 2);
  });

  it('refuses a payload whose tenant id is not a uuid — the worker takes its RLS scope from it (D7)', async () => {
    const h = harness();
    const job = makeJob(CAMPAIGN_BATCH_JOB, {
      data: { tenantId: 'evil', campaignId: CAMPAIGN, batch: 0 },
    } as Partial<Job<CampaignJobData>>);

    await expect(h.processor.process(job)).rejects.toThrow();
    expect(h.runBatch).not.toHaveBeenCalled();
  });
});

describe('CampaignSendProcessor.process — outcomes', () => {
  it('re-delays a deferral WITHOUT spending a retry attempt', async () => {
    const h = harness({
      batchThrows: new CampaignDeferredError(60_000, '24h limit reached'),
    });
    const job = makeJob(CAMPAIGN_BATCH_JOB);

    await expect(h.processor.process(job, 'token-1')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [when, token] = (job.moveToDelayed as jest.Mock).mock.calls[0];
    expect(when).toBeGreaterThanOrEqual(Date.now() + 60_000);
    expect(token).toBe('token-1');
  });

  it('completes quietly when the campaign is no longer sending', async () => {
    const h = harness({
      batchThrows: new CampaignNotSendingError('canceled'),
    });

    await expect(
      h.processor.process(makeJob(CAMPAIGN_BATCH_JOB)),
    ).resolves.toBeUndefined();
  });

  it('lets a real failure through, so BullMQ retries it with backoff', async () => {
    const h = harness({ batchThrows: new Error('connection reset') });

    await expect(
      h.processor.process(makeJob(CAMPAIGN_BATCH_JOB)),
    ).rejects.toThrow('connection reset');
  });
});

describe('CampaignSendProcessor.onFailed', () => {
  it('stays quiet while attempts remain', () => {
    const h = harness();
    h.processor.onFailed(
      makeJob(CAMPAIGN_BATCH_JOB, { attemptsMade: 1 } as Partial<
        Job<CampaignJobData>
      >),
      new Error('transient'),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('logs loudly once attempts are exhausted, and does NOT invent a terminal state', () => {
    const h = harness();
    h.processor.onFailed(
      makeJob(CAMPAIGN_BATCH_JOB, { attemptsMade: 3 } as Partial<
        Job<CampaignJobData>
      >),
      new Error('connection reset'),
    );
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/remaining recipients pending/),
      expect.any(String),
    );
  });
});
