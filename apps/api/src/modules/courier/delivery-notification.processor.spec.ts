// F26 (D5/D8): which outcomes are worth a BullMQ retry.
//
// Exactly one is: a failed BSP send, whose claim row is already held — so the
// retry cannot double-send a send that succeeded. Every other outcome is a
// DECISION (opted out, no template, not opted in, already claimed), and
// retrying a decision just re-runs the gates to reach the same conclusion
// while occupying a worker.
import type { Job } from 'bullmq';
import type { AppLoggerService } from '../core';
import type { DeliveryNotificationService } from './delivery-notification.service';
import { DeliveryNotificationProcessor } from './delivery-notification.processor';
import type { DeliveryNotificationJobData } from './delivery-notification.queue';

function makeProcessor(outcome: string, detail?: string) {
  const notify = jest.fn().mockResolvedValue({ outcome, detail });
  const processor = new DeliveryNotificationProcessor(
    { notify } as unknown as DeliveryNotificationService,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as AppLoggerService,
  );
  return { processor, notify };
}

const job = {
  data: {
    tenantId: 'tenant-a',
    shipmentId: 'ship-1',
    status: 'delivered',
  },
} as Job<DeliveryNotificationJobData>;

describe('DeliveryNotificationProcessor', () => {
  it('throws — and so retries — only for a failed BSP send', async () => {
    const { processor } = makeProcessor('failed', 'BSP 470');

    await expect(processor.process(job)).rejects.toThrow(/BSP 470/);
  });

  it.each([
    'sent',
    'already_claimed',
    'skipped_opt_out',
    'skipped_no_template',
    'skipped_disabled',
    'stale',
    'not_found',
  ])('does not retry the %s outcome', async (outcome) => {
    const { processor } = makeProcessor(outcome);

    await expect(processor.process(job)).resolves.toBeUndefined();
  });

  it('passes the job payload through unchanged', async () => {
    const { processor, notify } = makeProcessor('sent');

    await processor.process(job);

    expect(notify).toHaveBeenCalledWith('tenant-a', 'ship-1', 'delivered');
  });
});
