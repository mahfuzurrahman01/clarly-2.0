// Channel (WebhookModule, T11/T10): the enqueue half of "webhook ACKs <1s,
// respond path runs in a worker." WebhookIngestService calls this and
// returns immediately — it does not await the job actually running.
//
// T10: no longer enqueues one job per message directly — delegates to
// BurstCoalescingService, which buffers/debounces consecutive messages
// from the same customer into one coalesced turn (D8: "two distinct
// messages arriving ~1.5s apart... would otherwise trigger two concurrent
// LLM runs"). The BullMQ-level jobId dedup this class used to do
// (`jobId: data.bspMessageId`) moved into BurstCoalescingService's own
// per-window jobId scheme, since a single coalesced job now legitimately
// covers multiple bspMessageIds.
import { Injectable } from '@nestjs/common';
import { BurstCoalescingService } from '../conversation/burst-coalescing.service';
import type { RespondPathJobData } from './respond-path-job.dto';

@Injectable()
export class RespondPathProducerService {
  constructor(private readonly burstCoalescing: BurstCoalescingService) {}

  async enqueue(data: RespondPathJobData): Promise<void> {
    // Feature 16: a straight pass-through, still. The payload gained
    // `channel`/`channelAccountId` where it used to carry `phoneNumberId`,
    // and this class needed no other change — which is the T11 boundary
    // earning its keep exactly as the T0 port did.
    await this.burstCoalescing.recordMessage(data);
  }
}
