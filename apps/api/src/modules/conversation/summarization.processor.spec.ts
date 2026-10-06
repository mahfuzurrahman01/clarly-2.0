import type { Job } from 'bullmq';
import type { AppLoggerService } from '../core';
import { SummarizationProcessor } from './summarization.processor';
import type { SummarizationService } from './summarization.service';
import type { SummarizeJobData } from './summarize-job.dto';

function makeJob(
  overrides: Partial<Job<SummarizeJobData>> = {},
): Job<SummarizeJobData> {
  return {
    id: 'job-1',
    data: { tenantId: 'tenant-a', conversationId: 'conv-1' },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<SummarizeJobData>;
}

function makeSummarization(): {
  summarization: SummarizationService;
  summarize: jest.Mock;
} {
  const summarize = jest.fn().mockResolvedValue(undefined);
  return {
    summarization: { summarize } as unknown as SummarizationService,
    summarize,
  };
}

function makeLogger(): { logger: AppLoggerService; warn: jest.Mock } {
  const warn = jest.fn();
  return { logger: { warn } as unknown as AppLoggerService, warn };
}

describe('SummarizationProcessor.process()', () => {
  it('calls SummarizationService.summarize() with the job data', async () => {
    const { summarization, summarize } = makeSummarization();
    const { logger } = makeLogger();
    const processor = new SummarizationProcessor(summarization, logger);

    await processor.process(makeJob());

    expect(summarize).toHaveBeenCalledWith('tenant-a', 'conv-1');
  });
});

describe('SummarizationProcessor.onFailed()', () => {
  it('logs a warning but never creates a ticket (a stale summary does not affect whether the customer got a reply)', () => {
    const { summarization } = makeSummarization();
    const { logger, warn } = makeLogger();
    const processor = new SummarizationProcessor(summarization, logger);

    processor.onFailed(
      makeJob({ attemptsMade: 3, opts: { attempts: 3 } }),
      new Error('LLM error'),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] as [string])[0]).toContain('attempts exhausted');
  });

  it('is a no-op when job is undefined', () => {
    const { summarization } = makeSummarization();
    const { logger, warn } = makeLogger();
    const processor = new SummarizationProcessor(summarization, logger);

    expect(() => processor.onFailed(undefined, new Error('x'))).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
