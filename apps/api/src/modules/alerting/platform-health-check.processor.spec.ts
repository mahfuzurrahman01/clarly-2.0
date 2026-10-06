import type { AppLoggerService } from '../core';
import type { PlatformHealthCheckService } from './platform-health-check.service';
import { PlatformHealthCheckProcessor } from './platform-health-check.processor';

function makeProcessor(): {
  processor: PlatformHealthCheckProcessor;
  platformHealthCheck: { checkAll: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock };
} {
  const platformHealthCheck = { checkAll: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const processor = new PlatformHealthCheckProcessor(
    platformHealthCheck as unknown as PlatformHealthCheckService,
    logger as unknown as AppLoggerService,
  );
  return { processor, platformHealthCheck, logger };
}

describe('PlatformHealthCheckProcessor', () => {
  it('runs the sweep and logs a summary when alerts were found', async () => {
    const { processor, platformHealthCheck, logger } = makeProcessor();
    platformHealthCheck.checkAll.mockResolvedValue([
      { type: 'circuit_breaker_open' },
    ]);

    await processor.process();

    expect(platformHealthCheck.checkAll).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'PlatformHealthCheckProcessor',
    );
  });

  it('stays quiet when the sweep finds nothing', async () => {
    const { processor, platformHealthCheck, logger } = makeProcessor();
    platformHealthCheck.checkAll.mockResolvedValue([]);

    await processor.process();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a warning on job failure without throwing', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed({ id: 'job-1' } as never, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sweep boom'),
      'PlatformHealthCheckProcessor',
    );
  });

  it('logs "(unknown)" in place of a job id when BullMQ passes no job', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed(undefined, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('(unknown)'),
      'PlatformHealthCheckProcessor',
    );
  });
});
