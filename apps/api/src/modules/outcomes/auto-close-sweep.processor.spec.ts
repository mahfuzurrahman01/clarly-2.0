import type { AppLoggerService } from '../core';
import { AutoCloseSweepProcessor } from './auto-close-sweep.processor';
import type { AutoCloseSweepService } from './auto-close-sweep.service';

function makeProcessor(): {
  processor: AutoCloseSweepProcessor;
  autoCloseSweep: { sweepAllTenants: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock };
} {
  const autoCloseSweep = { sweepAllTenants: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const processor = new AutoCloseSweepProcessor(
    autoCloseSweep as unknown as AutoCloseSweepService,
    logger as unknown as AppLoggerService,
  );
  return { processor, autoCloseSweep, logger };
}

describe('AutoCloseSweepProcessor', () => {
  it('runs the sweep and logs a summary when conversations were closed', async () => {
    const { processor, autoCloseSweep, logger } = makeProcessor();
    autoCloseSweep.sweepAllTenants.mockResolvedValue([
      { tenantId: 'tenant-a', conversationId: 'conv-1', closedAt: new Date() },
    ]);

    await processor.process();

    expect(autoCloseSweep.sweepAllTenants).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'AutoCloseSweepProcessor',
    );
  });

  it('stays quiet when the sweep closes nothing', async () => {
    const { processor, autoCloseSweep, logger } = makeProcessor();
    autoCloseSweep.sweepAllTenants.mockResolvedValue([]);

    await processor.process();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a warning on job failure without throwing', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed({ id: 'job-1' } as never, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('job-1'),
      'AutoCloseSweepProcessor',
    );
  });

  it('logs "(unknown)" in place of a job id when BullMQ passes no job', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed(undefined, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('(unknown)'),
      'AutoCloseSweepProcessor',
    );
  });
});
