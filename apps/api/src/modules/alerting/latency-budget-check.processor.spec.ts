import type { AppLoggerService } from '../core';
import type { LatencyBudgetCheckService } from './latency-budget-check.service';
import { LatencyBudgetCheckProcessor } from './latency-budget-check.processor';

function makeProcessor(): {
  processor: LatencyBudgetCheckProcessor;
  latencyBudgetCheck: { checkAllTenants: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock };
} {
  const latencyBudgetCheck = { checkAllTenants: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const processor = new LatencyBudgetCheckProcessor(
    latencyBudgetCheck as unknown as LatencyBudgetCheckService,
    logger as unknown as AppLoggerService,
  );
  return { processor, latencyBudgetCheck, logger };
}

describe('LatencyBudgetCheckProcessor', () => {
  it('runs the sweep and logs a summary when alerts were found', async () => {
    const { processor, latencyBudgetCheck, logger } = makeProcessor();
    latencyBudgetCheck.checkAllTenants.mockResolvedValue([
      { tenantId: 'tenant-a' },
    ]);

    await processor.process();

    expect(latencyBudgetCheck.checkAllTenants).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'LatencyBudgetCheckProcessor',
    );
  });

  it('stays quiet when the sweep finds nothing', async () => {
    const { processor, latencyBudgetCheck, logger } = makeProcessor();
    latencyBudgetCheck.checkAllTenants.mockResolvedValue([]);

    await processor.process();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a warning on job failure without throwing', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed({ id: 'job-1' } as never, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sweep boom'),
      'LatencyBudgetCheckProcessor',
    );
  });

  it('logs "(unknown)" in place of a job id when BullMQ passes no job', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed(undefined, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('(unknown)'),
      'LatencyBudgetCheckProcessor',
    );
  });
});
