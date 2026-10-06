import type { Queue } from 'bullmq';
import type { LlmProvider } from '../llm/ports/llm-provider.port';
import type { ConversationService } from './conversation.service';
import { SummarizationService } from './summarization.service';
import type { SummarizeJobData } from './summarize-job.dto';

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = 'conv-1';

interface ConversationServiceMocks {
  getConversation: jest.Mock;
  getMessageCount: jest.Mock;
  getMessagesAfter: jest.Mock;
  updateSummary: jest.Mock;
}

function makeConversationService(
  overrides: Partial<ConversationServiceMocks> = {},
): { conversationService: ConversationService } & ConversationServiceMocks {
  const mocks: ConversationServiceMocks = {
    getConversation: jest.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '15551234567',
      lastInboundAt: new Date(),
      rollingSummary: null,
      summarizedThroughMessageCount: 0,
    }),
    getMessageCount: jest.fn().mockResolvedValue(0),
    getMessagesAfter: jest.fn().mockResolvedValue([]),
    updateSummary: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    conversationService: mocks as unknown as ConversationService,
    ...mocks,
  };
}

function makeQueue(): { queue: Queue<SummarizeJobData>; add: jest.Mock } {
  const add = jest.fn().mockResolvedValue(undefined);
  return { queue: { add } as unknown as Queue<SummarizeJobData>, add };
}

function makeLlmProvider(content = 'Updated summary.'): {
  llmProvider: LlmProvider;
  complete: jest.Mock;
} {
  const complete = jest.fn().mockResolvedValue({
    content,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  return { llmProvider: { complete } as unknown as LlmProvider, complete };
}

describe('SummarizationService.maybeScheduleSummarization()', () => {
  it('does not enqueue when fewer than the trigger threshold of new messages have accumulated', async () => {
    const { conversationService, getConversation, getMessageCount } =
      makeConversationService();
    getConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      summarizedThroughMessageCount: 5,
      rollingSummary: null,
    });
    getMessageCount.mockResolvedValue(15); // 10 new, below the 20 threshold
    const { queue, add } = makeQueue();
    const { llmProvider } = makeLlmProvider();
    const service = new SummarizationService(
      llmProvider,
      conversationService,
      queue,
    );

    await service.maybeScheduleSummarization(TENANT_A, CONVERSATION_ID);

    expect(add).not.toHaveBeenCalled();
  });

  it('enqueues a summarize job once the trigger threshold is reached, with a jobId deduped per conversation', async () => {
    const { conversationService, getConversation, getMessageCount } =
      makeConversationService();
    getConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      summarizedThroughMessageCount: 0,
      rollingSummary: null,
    });
    getMessageCount.mockResolvedValue(20);
    const { queue, add } = makeQueue();
    const { llmProvider } = makeLlmProvider();
    const service = new SummarizationService(
      llmProvider,
      conversationService,
      queue,
    );

    await service.maybeScheduleSummarization(TENANT_A, CONVERSATION_ID);

    expect(add).toHaveBeenCalledWith(
      'summarize',
      { tenantId: TENANT_A, conversationId: CONVERSATION_ID },
      { jobId: `summarize-${CONVERSATION_ID}` },
    );
  });

  it('does nothing when the conversation does not exist', async () => {
    const { conversationService, getConversation } = makeConversationService();
    getConversation.mockResolvedValue(null);
    const { queue, add } = makeQueue();
    const { llmProvider } = makeLlmProvider();
    const service = new SummarizationService(
      llmProvider,
      conversationService,
      queue,
    );

    await service.maybeScheduleSummarization(TENANT_A, CONVERSATION_ID);

    expect(add).not.toHaveBeenCalled();
  });
});

describe('SummarizationService.summarize()', () => {
  it('calls the LLM with the prior summary + only the new messages, and writes the result back', async () => {
    const newMessages = [
      { role: 'user' as const, content: 'Where is my order?' },
    ];
    const {
      conversationService,
      getConversation,
      getMessageCount,
      getMessagesAfter,
      updateSummary,
    } = makeConversationService();
    getConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      summarizedThroughMessageCount: 5,
      rollingSummary: 'Prior summary text.',
    });
    getMessageCount.mockResolvedValue(25);
    getMessagesAfter.mockResolvedValue(newMessages);
    const { queue } = makeQueue();
    const { llmProvider, complete } = makeLlmProvider(
      'Updated summary covering the order question.',
    );
    const service = new SummarizationService(
      llmProvider,
      conversationService,
      queue,
    );

    await service.summarize(TENANT_A, CONVERSATION_ID);

    expect(getMessagesAfter).toHaveBeenCalledWith(TENANT_A, CONVERSATION_ID, 5);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(updateSummary).toHaveBeenCalledWith(
      TENANT_A,
      CONVERSATION_ID,
      'Updated summary covering the order question.',
      25,
    );
  });

  it('does nothing when there are no new messages since the last summary', async () => {
    const {
      conversationService,
      getConversation,
      getMessageCount,
      getMessagesAfter,
      updateSummary,
    } = makeConversationService();
    getConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      summarizedThroughMessageCount: 20,
      rollingSummary: 'Existing summary.',
    });
    getMessageCount.mockResolvedValue(20);
    getMessagesAfter.mockResolvedValue([]);
    const { queue } = makeQueue();
    const { llmProvider, complete } = makeLlmProvider();
    const service = new SummarizationService(
      llmProvider,
      conversationService,
      queue,
    );

    await service.summarize(TENANT_A, CONVERSATION_ID);

    expect(complete).not.toHaveBeenCalled();
    expect(updateSummary).not.toHaveBeenCalled();
  });

  it('does nothing when the conversation does not exist', async () => {
    const { conversationService, getConversation } = makeConversationService();
    getConversation.mockResolvedValue(null);
    const { queue } = makeQueue();
    const { llmProvider, complete } = makeLlmProvider();
    const service = new SummarizationService(
      llmProvider,
      conversationService,
      queue,
    );

    await service.summarize(TENANT_A, CONVERSATION_ID);

    expect(complete).not.toHaveBeenCalled();
  });
});
