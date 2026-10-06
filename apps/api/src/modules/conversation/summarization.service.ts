// Product shell (ConversationModule, A7/D7): "summarization runs async
// after reply, never on the respond path." Two distinct responsibilities,
// kept in one small service since they're both "policy," not mechanics
// (ConversationService owns the mechanics — reading/writing rows):
//   - maybeScheduleSummarization(): the cheap trigger check, called
//     synchronously by whatever finishes a turn (no LLM call, safe to run
//     on the respond path itself).
//   - summarize(): the actual LLM call, run only inside
//     SummarizationProcessor's worker — never called from the respond path.
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { LlmProvider } from '../llm/ports/llm-provider.port';
import { ConversationService } from './conversation.service';
import { buildSummarizationPrompt } from './summarization-prompt';
import type { SummarizeJobData } from './summarize-job.dto';
import { SUMMARIZE_QUEUE } from './summarize.queue';

/** How many messages accumulate beyond the last summarization point before triggering another — 2x the recent-window size (10), so the summary always covers everything older than what the recent window already carries verbatim, with margin. */
const SUMMARIZE_TRIGGER_MESSAGE_COUNT = 20;
/** Caps the summarization LLM call's own output — keeps the summary itself from growing unbounded across many resummarizations. */
const SUMMARY_MAX_OUTPUT_TOKENS = 400;

@Injectable()
export class SummarizationService {
  constructor(
    private readonly llmProvider: LlmProvider,
    private readonly conversationService: ConversationService,
    @InjectQueue(SUMMARIZE_QUEUE)
    private readonly queue: Queue<SummarizeJobData>,
  ) {}

  /** Cheap (one row read + a count query, no LLM call) — safe to call from the respond path. Idempotent: `jobId` keyed on conversationId means a second trigger while one is already queued/running is a harmless no-op (BullMQ dedups by jobId). */
  async maybeScheduleSummarization(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.conversationService.getConversation(
      tenantId,
      conversationId,
    );
    if (!conversation) return;

    const messageCount = await this.conversationService.getMessageCount(
      tenantId,
      conversationId,
    );
    const newSinceLastSummary =
      messageCount - conversation.summarizedThroughMessageCount;
    if (newSinceLastSummary < SUMMARIZE_TRIGGER_MESSAGE_COUNT) return;

    await this.queue.add(
      'summarize',
      { tenantId, conversationId },
      { jobId: `summarize-${conversationId}` },
    );
  }

  /** The actual LLM call — only ever invoked from SummarizationProcessor's worker, never the respond path. */
  async summarize(tenantId: string, conversationId: string): Promise<void> {
    const conversation = await this.conversationService.getConversation(
      tenantId,
      conversationId,
    );
    if (!conversation) return;

    const messageCount = await this.conversationService.getMessageCount(
      tenantId,
      conversationId,
    );
    const newMessages = await this.conversationService.getMessagesAfter(
      tenantId,
      conversationId,
      conversation.summarizedThroughMessageCount,
    );
    if (newMessages.length === 0) return;

    const result = await this.llmProvider.complete({
      messages: buildSummarizationPrompt(
        conversation.rollingSummary,
        newMessages,
      ),
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });

    await this.conversationService.updateSummary(
      tenantId,
      conversationId,
      result.content,
      messageCount,
    );
  }
}
