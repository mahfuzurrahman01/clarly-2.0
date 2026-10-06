import type Redis from 'ioredis';
import type { Queue, Job } from 'bullmq';
import type { AppConfigService } from '../core';
import {
  BurstCoalescingService,
  type InboundMessage,
} from './burst-coalescing.service';
import type { CoalescedRespondJobData } from './coalesced-respond-job.dto';

const TRACKER_KEY = 'coalesce:tracker:tenant-a:15551234567';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    tenantId: 'tenant-a',
    channel: 'whatsapp' as const,
    channelAccountId: 'PHONE_NUMBER_ID',
    from: '15551234567',
    providerMessageId: 'wamid.1',
    text: 'hi',
    ...overrides,
  };
}

function makeConfig(debounceMs = 1500): AppConfigService {
  return { burstCoalesceDebounceMs: debounceMs } as unknown as AppConfigService;
}

function makeRedis(trackerValue: string | null = null): {
  redis: Redis;
  get: jest.Mock;
  set: jest.Mock;
  expire: jest.Mock;
} {
  const get = jest.fn().mockResolvedValue(trackerValue);
  const set = jest.fn().mockResolvedValue('OK');
  const expire = jest.fn().mockResolvedValue(1);
  return { redis: { get, set, expire } as unknown as Redis, get, set, expire };
}

function makeQueue(
  jobs: Record<string, Partial<Job<CoalescedRespondJobData>>> = {},
): {
  queue: Queue<CoalescedRespondJobData>;
  add: jest.Mock;
  getJob: jest.Mock;
} {
  const add = jest.fn().mockResolvedValue(undefined);
  const getJob = jest.fn((jobId: string) =>
    Promise.resolve(jobs[jobId] ?? undefined),
  );
  return {
    queue: { add, getJob } as unknown as Queue<CoalescedRespondJobData>,
    add,
    getJob,
  };
}

describe('BurstCoalescingService.recordMessage() — no existing window', () => {
  it('creates a new delayed job and sets the tracker when no window is currently open', async () => {
    const { redis, set } = makeRedis(null);
    const { queue, add } = makeQueue();
    const service = new BurstCoalescingService(queue, redis, makeConfig(1500));

    await service.recordMessage(makeMessage());

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as [
      string,
      {
        tenantId: string;
        from: string;
        messages: Array<{ providerMessageId: string; text: string }>;
      },
      { jobId: string; delay: number },
    ];
    expect(name).toBe('respond');
    expect(data).toEqual({
      tenantId: 'tenant-a',
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from: '15551234567',
      messages: [{ providerMessageId: 'wamid.1', text: 'hi' }],
    });
    expect(opts.jobId.startsWith('coalesce-tenant-a_15551234567-')).toBe(true);
    expect(opts.delay).toBe(1500);

    expect(set).toHaveBeenCalledTimes(1);
    const setArgs = set.mock.calls[0] as [string, string, string, number];
    expect(setArgs[0]).toBe(TRACKER_KEY);
    expect(setArgs[2]).toBe('EX');
    expect(typeof setArgs[3]).toBe('number');
  });
});

describe('BurstCoalescingService.recordMessage() — an open window exists', () => {
  it('appends the new message to the existing delayed job and resets its delay (true debounce, not just dedup)', async () => {
    const existingJobId = 'coalesce-tenant-a_15551234567-abc';
    const updateData = jest.fn().mockResolvedValue(undefined);
    const changeDelay = jest.fn().mockResolvedValue(undefined);
    const isDelayed = jest.fn().mockResolvedValue(true);
    const existingJob = {
      data: {
        tenantId: 'tenant-a',
        from: '15551234567',
        messages: [{ providerMessageId: 'wamid.1', text: 'hi' }],
      },
      isDelayed,
      updateData,
      changeDelay,
    };
    const { redis } = makeRedis(existingJobId);
    const { queue, add } = makeQueue({
      [existingJobId]: existingJob as unknown as Job<CoalescedRespondJobData>,
    });
    const service = new BurstCoalescingService(queue, redis, makeConfig(1500));

    await service.recordMessage(
      makeMessage({ providerMessageId: 'wamid.2', text: 'still there?' }),
    );

    expect(updateData).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      from: '15551234567',
      messages: [
        { providerMessageId: 'wamid.1', text: 'hi' },
        { providerMessageId: 'wamid.2', text: 'still there?' },
      ],
    });
    expect(changeDelay).toHaveBeenCalledWith(1500);
    expect(add).not.toHaveBeenCalled();
  });

  it('3 messages recorded in sequence coalesce into exactly one job with all 3 messages (T10 verify: one turn, not three)', async () => {
    let jobData: CoalescedRespondJobData | undefined;
    const jobId = 'coalesce-tenant-a_15551234567-abc';
    const isDelayed = jest.fn().mockResolvedValue(true);
    const updateData = jest.fn((data: CoalescedRespondJobData) => {
      jobData = data;
      return Promise.resolve(undefined);
    });
    const changeDelay = jest.fn().mockResolvedValue(undefined);

    const { redis, get } = makeRedis(null);
    const { queue, add, getJob } = makeQueue();
    add.mockImplementation((_name: string, data: CoalescedRespondJobData) => {
      jobData = data;
      return Promise.resolve(undefined);
    });
    getJob.mockImplementation(() =>
      Promise.resolve(
        jobData
          ? { data: jobData, isDelayed, updateData, changeDelay }
          : undefined,
      ),
    );
    const service = new BurstCoalescingService(queue, redis, makeConfig(1500));

    await service.recordMessage(
      makeMessage({ providerMessageId: 'msg-1', text: 'hi' }),
    );
    get.mockResolvedValue(jobId); // subsequent calls see the tracker this "first" call would have set
    await service.recordMessage(
      makeMessage({ providerMessageId: 'msg-2', text: 'my order is late' }),
    );
    await service.recordMessage(
      makeMessage({ providerMessageId: 'msg-3', text: 'hello?' }),
    );

    expect(add).toHaveBeenCalledTimes(1);
    expect(jobData?.messages.map((m) => m.providerMessageId)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
    ]);
  });
});

describe('BurstCoalescingService.recordMessage() — stale tracker', () => {
  it('starts a fresh window when the tracked job is no longer delayed (already picked up)', async () => {
    const existingJobId = 'coalesce-tenant-a_15551234567-abc';
    const isDelayed = jest.fn().mockResolvedValue(false);
    const existingJob = {
      data: {},
      isDelayed,
      updateData: jest.fn(),
      changeDelay: jest.fn(),
    };
    const { redis } = makeRedis(existingJobId);
    const { queue, add } = makeQueue({
      [existingJobId]: existingJob as unknown as Job<CoalescedRespondJobData>,
    });
    const service = new BurstCoalescingService(queue, redis, makeConfig(1500));

    await service.recordMessage(makeMessage());

    expect(add).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh window when the tracked job no longer exists (expired/removed)', async () => {
    const { redis } = makeRedis('coalesce-tenant-a_15551234567-gone');
    const { queue, add } = makeQueue({}); // getJob() resolves undefined for any id
    const service = new BurstCoalescingService(queue, redis, makeConfig(1500));

    await service.recordMessage(makeMessage());

    expect(add).toHaveBeenCalledTimes(1);
  });
});
