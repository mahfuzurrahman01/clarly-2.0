// F19 (D3, D9): the producer half of the queue — WHEN work enters, never
// what the work is.
import type { Queue } from 'bullmq';
import type { AppLoggerService, Clock } from '../core';
import {
  CAMPAIGN_BATCH_JOB,
  CAMPAIGN_LAUNCH_JOB,
  campaignBatchJobId,
  campaignLaunchJobId,
  campaignJobSchema,
} from './campaign-send.queue';
import { CampaignSendSchedulerService } from './campaign-send.scheduler.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';
const NOW = new Date('2026-09-22T12:00:00.000Z');

function harness(queueOverrides: Partial<Queue> = {}) {
  const add = jest.fn().mockResolvedValue({ id: 'job-1' });
  const remove = jest.fn().mockResolvedValue(1);
  const queue = { add, remove, ...queueOverrides } as unknown as Queue;
  const warn = jest.fn();
  const service = new CampaignSendSchedulerService(
    queue,
    { now: () => NOW } as unknown as Clock,
    { warn } as unknown as AppLoggerService,
  );
  return { service, add, remove, warn };
}

describe('CampaignSendSchedulerService.scheduleLaunch', () => {
  it('delays the launch until the scheduled time', async () => {
    const { service, add } = harness();
    await service.scheduleLaunch(
      TENANT,
      CAMPAIGN,
      new Date(NOW.getTime() + 60_000),
    );

    expect(add).toHaveBeenCalledWith(
      CAMPAIGN_LAUNCH_JOB,
      { tenantId: TENANT, campaignId: CAMPAIGN, batch: 0 },
      { jobId: campaignLaunchJobId(CAMPAIGN), delay: 60_000 },
    );
  });

  it('treats "now", a null time and a time in the past as the same operation — a zero delay', async () => {
    const { service, add } = harness();
    await service.scheduleLaunch(TENANT, CAMPAIGN, null);
    await service.scheduleLaunch(
      TENANT,
      CAMPAIGN,
      new Date(NOW.getTime() - 86_400_000),
    );

    expect(add.mock.calls[0][2].delay).toBe(0);
    expect(add.mock.calls[1][2].delay).toBe(0);
  });

  it('uses a deterministic job id, so a double schedule is a no-op in BullMQ rather than two launches', async () => {
    const { service, add } = harness();
    await service.scheduleLaunch(TENANT, CAMPAIGN, null);
    await service.scheduleLaunch(TENANT, CAMPAIGN, null);

    expect(add.mock.calls[0][2].jobId).toBe(add.mock.calls[1][2].jobId);
  });
});

describe('CampaignSendSchedulerService.cancelScheduledLaunch', () => {
  it('removes the delayed launch job', async () => {
    const { service, remove } = harness();
    await service.cancelScheduledLaunch(CAMPAIGN);
    expect(remove).toHaveBeenCalledWith(campaignLaunchJobId(CAMPAIGN));
  });

  it('swallows a removal failure — a job already running is stopped by the campaign status, not by the queue', async () => {
    const { service, warn } = harness({
      remove: jest.fn().mockRejectedValue(new Error('job is locked')),
    });

    await expect(
      service.cancelScheduledLaunch(CAMPAIGN),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('CampaignSendSchedulerService.enqueueBatch', () => {
  it('enqueues the next batch with no delay by default', async () => {
    const { service, add } = harness();
    await service.enqueueBatch(TENANT, CAMPAIGN, 7);

    expect(add).toHaveBeenCalledWith(
      CAMPAIGN_BATCH_JOB,
      { tenantId: TENANT, campaignId: CAMPAIGN, batch: 7 },
      { jobId: campaignBatchJobId(CAMPAIGN, 7), delay: 0 },
    );
  });

  it('carries a rate-limit deferral forward as the job delay', async () => {
    const { service, add } = harness();
    await service.enqueueBatch(TENANT, CAMPAIGN, 8, 5_000);
    expect(add.mock.calls[0][2].delay).toBe(5_000);
  });

  it('gives each batch of a campaign its own job id', () => {
    expect(campaignBatchJobId(CAMPAIGN, 0)).not.toBe(
      campaignBatchJobId(CAMPAIGN, 1),
    );
  });
});

describe('campaignJobSchema', () => {
  it('defaults the batch so a launch payload needs no batch number', () => {
    expect(
      campaignJobSchema.parse({ tenantId: TENANT, campaignId: CAMPAIGN }),
    ).toEqual({ tenantId: TENANT, campaignId: CAMPAIGN, batch: 0 });
  });

  it('refuses a payload whose tenant id is not a uuid — the worker takes its tenant scope from this', () => {
    expect(() =>
      campaignJobSchema.parse({ tenantId: 'not-a-uuid', campaignId: CAMPAIGN }),
    ).toThrow();
  });
});
