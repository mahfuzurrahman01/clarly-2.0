import type { AppLoggerService } from '../core';
import type { ToolScopeViolationCheckService } from './tool-scope-violation-check.service';
import { ToolScopeViolationCheckProcessor } from './tool-scope-violation-check.processor';

function makeProcessor(): {
  processor: ToolScopeViolationCheckProcessor;
  toolScopeViolationCheck: { checkAllTenants: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock };
} {
  const toolScopeViolationCheck = { checkAllTenants: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const processor = new ToolScopeViolationCheckProcessor(
    toolScopeViolationCheck as unknown as ToolScopeViolationCheckService,
    logger as unknown as AppLoggerService,
  );
  return { processor, toolScopeViolationCheck, logger };
}

describe('ToolScopeViolationCheckProcessor', () => {
  it('runs the sweep and logs a summary when alerts were found', async () => {
    const { processor, toolScopeViolationCheck, logger } = makeProcessor();
    toolScopeViolationCheck.checkAllTenants.mockResolvedValue([
      { tenantId: 'tenant-a' },
    ]);

    await processor.process();

    expect(toolScopeViolationCheck.checkAllTenants).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'ToolScopeViolationCheckProcessor',
    );
  });

  it('stays quiet when the sweep finds nothing', async () => {
    const { processor, toolScopeViolationCheck, logger } = makeProcessor();
    toolScopeViolationCheck.checkAllTenants.mockResolvedValue([]);

    await processor.process();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a warning on job failure without throwing', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed({ id: 'job-1' } as never, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sweep boom'),
      'ToolScopeViolationCheckProcessor',
    );
  });

  it('logs "(unknown)" in place of a job id when BullMQ passes no job', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed(undefined, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('(unknown)'),
      'ToolScopeViolationCheckProcessor',
    );
  });
});
