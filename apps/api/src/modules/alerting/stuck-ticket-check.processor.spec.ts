import type { AppLoggerService } from '../core';
import type { StuckTicketCheckService } from './stuck-ticket-check.service';
import { StuckTicketCheckProcessor } from './stuck-ticket-check.processor';

function makeProcessor(): {
  processor: StuckTicketCheckProcessor;
  stuckTicketCheck: { checkAllTenants: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock };
} {
  const stuckTicketCheck = { checkAllTenants: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const processor = new StuckTicketCheckProcessor(
    stuckTicketCheck as unknown as StuckTicketCheckService,
    logger as unknown as AppLoggerService,
  );
  return { processor, stuckTicketCheck, logger };
}

describe('StuckTicketCheckProcessor', () => {
  it('runs the sweep and logs a summary when alerts were found', async () => {
    const { processor, stuckTicketCheck, logger } = makeProcessor();
    stuckTicketCheck.checkAllTenants.mockResolvedValue([
      { ticketId: 'ticket-1' },
    ]);

    await processor.process();

    expect(stuckTicketCheck.checkAllTenants).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'StuckTicketCheckProcessor',
    );
  });

  it('stays quiet when the sweep finds nothing', async () => {
    const { processor, stuckTicketCheck, logger } = makeProcessor();
    stuckTicketCheck.checkAllTenants.mockResolvedValue([]);

    await processor.process();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a warning on job failure without throwing', () => {
    const { processor, logger } = makeProcessor();

    processor.onFailed({ id: 'job-1' } as never, new Error('sweep boom'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sweep boom'),
      'StuckTicketCheckProcessor',
    );
  });
});
