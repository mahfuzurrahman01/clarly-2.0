// Feature 4/A7 exit criteria (former FEATURE_PLAN.md): "60-turn conversation
// stays under token budget and preserves earlier facts." Proven here at a
// smaller but structurally identical scale (25 turns — enough to cross
// SummarizationService's trigger threshold at least once, which is the
// actual mechanism that makes ANY conversation length safe, not just a
// specific turn count): the recent-window query always caps at 10
// regardless of total message count, and the rolling summary actually
// gets populated once enough history accumulates, carrying facts forward
// that have scrolled out of the recent window.
//
// Drives the REAL respond path end-to-end: BurstCoalescingService ->
// `respond-path` queue -> RespondPathProcessor -> ConversationLockService
// -> AgentRuntime -> ConversationService -> (eventually)
// SummarizationService -> `conversation-summarize` queue ->
// SummarizationProcessor. `LlmProvider`/`Embedder` are overridden with
// deterministic fakes (no real DeepSeek/OpenAI account in this
// environment); everything else — Postgres, pgvector retrieval, Redis,
// BullMQ, the advisory lock — is real.
//
// Requires real Postgres (pgvector) + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { RESPOND_TOOL_NAME } from '../../src/modules/agent/respond-tool-definition';
import { ConversationService } from '../../src/modules/conversation/conversation.service';
import { CoreModule } from '../../src/modules/core/core.module';
import { Embedder } from '../../src/modules/llm/ports/embedder.port';
import { FakeEmbedder } from './fixtures/deterministic-embedding';
import { BspAdapter } from '../../src/modules/whatsapp/ports/bsp-adapter.port';
import { RecordingBspAdapter } from './fixtures/recording-bsp-adapter';
import { NoopRerankerAdapter } from '../../src/modules/retrieval/noop-reranker.adapter';
import { Reranker } from '../../src/modules/retrieval/ports/reranker.port';
import {
  LlmProvider,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmToolRequest,
  type LlmToolResult,
} from '../../src/modules/llm/ports/llm-provider.port';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { TenantPolicyService } from '../../src/modules/onboarding/tenant-policy.service';
import {
  kbDocuments,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RetrievalIngestService } from '../../src/modules/retrieval/retrieval-ingest.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { RespondPathProducerService } from '../../src/modules/webhook/respond-path-producer.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';

/**
 * Every `completeWithTools()` request the respond path actually produced, in
 * order. This is the only way to answer the question the memory tests are
 * really asking — not "did we store the transcript" (a `messages` count
 * proves that) but "did the AGENT SEE it on the next turn". D7 memory is
 * assembled by the processor, handed to `AgentRuntime` and rendered by the
 * prompt layers; every one of those links can break without any row count
 * changing.
 */
const capturedToolRequests: LlmToolRequest[] = [];

/** completeWithTools() always terminates via `respond` citing whatever L4 retrieved, never escalating — keeps every turn a plain, fast success so the test can drive many turns quickly. complete() (summarization's call) returns a short canned summary. */
class ScriptedLlmProvider extends LlmProvider {
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const userTurn = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    return {
      content: `Summary so far, including: ${userTurn?.content.slice(0, 60) ?? ''}`,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async completeWithTools(request: LlmToolRequest): Promise<LlmToolResult> {
    capturedToolRequests.push(request);
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const citedChunkIds = [
      ...(systemMessage?.content.matchAll(/<chunk id="([^"]+)">/g) ?? []),
    ].map((match) => match[1]);

    return {
      content: '',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [
        {
          id: `call-${randomUUID()}`,
          name: RESPOND_TOOL_NAME,
          input: {
            answer: 'Acknowledged.',
            cited_chunk_ids: citedChunkIds,
            confidence: 0.9,
            escalate: false,
          },
        },
      ],
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async countTokens(): Promise<number> {
    return 0;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

describe('Conversation memory (Feature 4/A7 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let conversationService: ConversationService;
  let respondPathProducer: RespondPathProducerService;
  let storageDir: string;
  const bspAdapter = new RecordingBspAdapter();

  const tenantId = randomUUID();
  const customerPhone = '15559998888';
  const DEBOUNCE_MS = 50;

  beforeAll(async () => {
    process.env.BURST_COALESCE_DEBOUNCE_MS = String(DEBOUNCE_MS);
    storageDir = join(tmpdir(), `conversation-memory-test-${randomUUID()}`);
    process.env.KB_LOCAL_STORAGE_DIR = storageDir;

    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WebhookModule,
        OnboardingModule,
      ],
    })
      .overrideProvider(Embedder)
      .useClass(FakeEmbedder)
      // The Reranker is pinned to the no-op adapter rather than left on
      // whatever RERANK_PROVIDER the developer's .env happens to name.
      // With a real Cohere key present these suites made a live rerank
      // call per turn and were observed failing outright on HTTP 429 —
      // a third-party rate limit deciding whether our test run is green.
      // The no-op adapter returns the RRF-fused order, which is exactly
      // what the degradation path in RetrievalSearchService now falls
      // back to anyway, so nothing under test changes shape.
      .overrideProvider(Reranker)
      .useClass(NoopRerankerAdapter)
      // Outbound delivery is the last link of the respond path and it is
      // NOT optional to the assertions here: with the real adapter the send
      // fails, and the processor correctly rewrites the turn into a
      // TOOL_FAILURE ticket + an `error` agent_runs row. A suite about a
      // normal turn would then be silently asserting against the
      // delivery-failure path.
      .overrideProvider(BspAdapter)
      .useValue(bspAdapter)
      .overrideProvider(LlmProvider)
      .useClass(ScriptedLlmProvider)
      .compile();

    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    conversationService = moduleRef.get(ConversationService);
    respondPathProducer = moduleRef.get(RespondPathProducerService);
    const tenantPolicyService = moduleRef.get(TenantPolicyService);
    const retrievalIngest = moduleRef.get(RetrievalIngestService);

    await persistence.runAdminQuery((db) =>
      db
        .insert(tenants)
        .values({ id: tenantId, name: 'Conversation Memory Test Tenant' }),
    );
    await tenantPolicyService.upsert(tenantId, { confidenceThreshold: 0.5 });

    const kbDocumentId = randomUUID();
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(kbDocuments).values({
          id: kbDocumentId,
          tenantId,
          filename: 'faq.txt',
          storageKey: `${tenantId}/${kbDocumentId}`,
          mimeType: 'text/plain',
          sizeBytes: 0,
          status: 'uploaded',
        }),
      tenantId,
    );
    await retrievalIngest.ingestDocument({
      tenantId,
      kbDocumentId,
      content: Buffer.from(
        'Our support hours are 9am to 6pm, Monday through Friday.',
      ),
      mimeType: 'text/plain',
    });
  }, 30000);

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.KB_LOCAL_STORAGE_DIR;
    delete process.env.BURST_COALESCE_DEBOUNCE_MS;
  });

  it('a 25-turn conversation stays under token budget (recent window always <=10) and preserves earlier facts (rolling summary gets populated)', async () => {
    const TURN_COUNT = 25;

    for (let turn = 1; turn <= TURN_COUNT; turn++) {
      await respondPathProducer.enqueue({
        tenantId,
        channel: 'whatsapp',
        channelAccountId: 'PHONE_NUMBER_ID',
        providerMessageId: `wamid.turn-${turn}-${randomUUID()}`,
        from: customerPhone,
        text: `Turn ${turn}: what are your support hours?`,
      });

      // Each turn adds exactly 2 rows (1 user + 1 assistant) — wait for
      // this turn's pair to land before sending the next, so messages
      // arrive spaced out as separate turns rather than coalescing into
      // one batch.
      await waitUntil(async () => {
        const conversation = await conversationService.getOrCreateConversation(
          tenantId,
          customerPhone,
        );
        const count = await conversationService.getMessageCount(
          tenantId,
          conversation.id,
        );
        return count >= turn * 2;
      });
    }

    const conversation = await conversationService.getOrCreateConversation(
      tenantId,
      customerPhone,
    );
    const totalMessages = await conversationService.getMessageCount(
      tenantId,
      conversation.id,
    );
    expect(totalMessages).toBe(TURN_COUNT * 2);

    // D7's token-budget mechanism: the recent window is capped
    // regardless of how long the conversation has actually gotten.
    const recentWindow = await conversationService.getRecentWindow(
      tenantId,
      conversation.id,
    );
    expect(recentWindow.length).toBeLessThanOrEqual(10);

    // D7's "preserves earlier facts" mechanism: once enough messages
    // accumulate beyond the recent window, SummarizationService's
    // trigger fires and the async worker actually writes a summary —
    // proof that facts from turn 1 (long since scrolled out of the
    // 10-message recent window by turn 25) are still recoverable.
    await waitUntil(async () => {
      const updated = await conversationService.getConversation(
        tenantId,
        conversation.id,
      );
      return (
        updated !== null &&
        updated.rollingSummary !== null &&
        updated.summarizedThroughMessageCount > 0
      );
    });

    const finalConversation = await conversationService.getConversation(
      tenantId,
      conversation.id,
    );
    expect(finalConversation?.rollingSummary).toBeTruthy();
    expect(finalConversation?.summarizedThroughMessageCount).toBeGreaterThan(0);
  }, 180000);

  // The gap this closes: the 161-case eval calls AgentRuntime.respond()
  // DIRECTLY, constructing `recentMessages`/`conversationSummary` itself, and
  // the test above only proves rows landed in `messages`. Neither one proves
  // the thing D7 actually promises — that the processor reads prior state and
  // the agent SEES it on the next turn. Every link between those two facts
  // (read-before-write ordering in the processor, the AgentTurnInput mapping,
  // the prompt layer that renders history) can break without a single row
  // count changing, and nothing would have caught it.
  it('replays prior turns to the agent on the next turn, oldest-first and in order (D7 working memory over the real respond path)', async () => {
    const phone = '15557776666';
    const turns = [
      'My order number is A-4471.',
      'It has not arrived yet.',
      'What should I do about it?',
    ];

    for (const [index, text] of turns.entries()) {
      await respondPathProducer.enqueue({
        tenantId,
        channel: 'whatsapp',
        channelAccountId: 'PHONE_NUMBER_ID',
        providerMessageId: `wamid.multiturn-${index}-${randomUUID()}`,
        from: phone,
        text,
      });

      // One turn at a time — otherwise T10's debounce coalesces them into a
      // single turn and there is no "prior turn" to replay.
      await waitUntil(async () => {
        const conversation = await conversationService.getOrCreateConversation(
          tenantId,
          phone,
        );
        const count = await conversationService.getMessageCount(
          tenantId,
          conversation.id,
        );
        return count >= (index + 1) * 2;
      });
    }

    // The request that produced the LAST turn. Matched on its own text
    // rather than by index: this suite shares one worker with the 25-turn
    // test above, so absolute positions in the capture array are not stable.
    const finalRequest = capturedToolRequests.findLast((request) =>
      request.messages.some((message) =>
        message.content.includes('What should I do about it?'),
      ),
    );
    expect(finalRequest).toBeDefined();

    const history = finalRequest!.messages.filter(
      (message) => message.role !== 'system',
    );

    // Prior turns are present as real conversation turns, not summarized
    // away and not silently dropped: two customer messages and the two
    // replies to them, then the current message last.
    expect(history.map((message) => message.content)).toEqual([
      'My order number is A-4471.',
      'Acknowledged.',
      'It has not arrived yet.',
      'Acknowledged.',
      expect.stringContaining('What should I do about it?') as unknown,
    ]);
    expect(history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);

    // And specifically: the order id from turn 1 is still in front of the
    // model on turn 3, which is the whole point of D7's recent window.
    expect(history.some((message) => message.content.includes('A-4471'))).toBe(
      true,
    );
  }, 60000);

  // Burst coalescing (T10/D8) is upstream of everything above: if it drops or
  // reorders a message, the agent reasons over a corrupted turn and no
  // downstream assertion notices.
  it('coalesces a burst into ONE turn whose currentMessage preserves every message, in arrival order', async () => {
    const phone = '15554443333';
    const burst = ['I need to change my order', 'to the large size', 'please'];

    const before = capturedToolRequests.length;
    for (const [index, text] of burst.entries()) {
      await respondPathProducer.enqueue({
        tenantId,
        channel: 'whatsapp',
        channelAccountId: 'PHONE_NUMBER_ID',
        providerMessageId: `wamid.burst-${index}-${randomUUID()}`,
        from: phone,
        text,
      });
    }

    await waitUntil(async () => {
      const conversation = await conversationService.getOrCreateConversation(
        tenantId,
        phone,
      );
      return (
        (await conversationService.getMessageCount(
          tenantId,
          conversation.id,
        )) >=
        burst.length + 1
      );
    });

    const requests = capturedToolRequests.slice(before);
    const burstRequests = requests.filter((request) =>
      request.messages.some((message) =>
        message.content.includes('I need to change my order'),
      ),
    );
    // One LLM turn for the whole burst — not three.
    expect(burstRequests).toHaveLength(1);

    const currentMessage = burstRequests[0].messages.at(-1)!.content;
    for (const text of burst) expect(currentMessage).toContain(text);
    // Order matters as much as presence: "to the large size" before
    // "please" is the difference between a coherent request and word salad.
    expect(currentMessage.indexOf(burst[0])).toBeLessThan(
      currentMessage.indexOf(burst[1]),
    );
    expect(currentMessage.indexOf(burst[1])).toBeLessThan(
      currentMessage.indexOf(burst[2]),
    );

    // The transcript keeps one row per original message (T10's own
    // contract), and in the same order the agent was shown.
    const conversation = await conversationService.getOrCreateConversation(
      tenantId,
      phone,
    );
    const window = await conversationService.getRecentWindow(
      tenantId,
      conversation.id,
    );
    expect(window.map((message) => message.content)).toEqual([
      ...burst,
      'Acknowledged.',
    ]);
  }, 60000);
});
