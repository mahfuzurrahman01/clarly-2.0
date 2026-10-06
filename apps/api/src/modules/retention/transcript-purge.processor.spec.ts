import type { AppLoggerService } from '../core';
import { TranscriptPurgeProcessor } from './transcript-purge.processor';
import type { TranscriptPurgeService } from './transcript-purge.service';

function makeProcessor(): {
  processor: TranscriptPurgeProcessor;
  transcriptPurge: { purgeAllTenants: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock };
} {
  const transcriptPurge = { purgeAllTenants: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const processor = new TranscriptPurgeProcessor(
    transcriptPurge as unknown as TranscriptPurgeService,
    logger as unknown as AppLoggerService,
  );
  return { processor, transcriptPurge, logger };
}

describe('TranscriptPurgeProcessor', () => {
  it('runs the purge and logs a summary when anything was purged', async () => {
    const { processor, transcriptPurge, logger } = makeProcessor();
    transcriptPurge.purgeAllTenants.mockResolvedValue([
      { tenantId: 'tenant-a', conversationsPurged: 2, messagesPurged: 10 },
    ]);

    await processor.process();

    expect(transcriptPurge.purgeAllTenants).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('2 conversation'),
      'TranscriptPurgeProcessor',
    );
  });

  it('stays quiet when nothing was purged', async () => {
    const { processor, transcriptPurge, logger } = makeProcessor();
    transcriptPurge.purgeAllTenants.mockResolvedValue([]);

    await processor.process();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a warning on job failure without throwing', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed({ id: 'job-1' } as never, new Error('purge boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('job-1'),
      'TranscriptPurgeProcessor',
    );
  });

  it('logs "(unknown)" in place of a job id when BullMQ passes no job', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed(undefined, new Error('purge boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('(unknown)'),
      'TranscriptPurgeProcessor',
    );
  });
});
