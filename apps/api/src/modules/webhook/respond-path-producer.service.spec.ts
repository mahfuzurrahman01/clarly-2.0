import type { BurstCoalescingService } from '../conversation/burst-coalescing.service';
import { RespondPathProducerService } from './respond-path-producer.service';
import type { RespondPathJobData } from './respond-path-job.dto';

describe('RespondPathProducerService.enqueue()', () => {
  it('delegates to BurstCoalescingService.recordMessage() (T10: coalescing happens there, not a direct queue.add() anymore)', async () => {
    const recordMessage = jest.fn().mockResolvedValue(undefined);
    const burstCoalescing = {
      recordMessage,
    } as unknown as BurstCoalescingService;
    const service = new RespondPathProducerService(burstCoalescing);

    const data: RespondPathJobData = {
      tenantId: 'tenant-a',
      channel: 'whatsapp' as const,
      channelAccountId: 'PHONE_NUMBER_ID',
      providerMessageId: 'msg-1',
      from: '15551234567',
      text: 'hi',
    };

    await service.enqueue(data);

    expect(recordMessage).toHaveBeenCalledWith(data);
  });
});
