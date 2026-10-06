// Feature 7 exit criteria (A8): "every respond path writes exactly one
// agent_runs row, including escalation and error paths." Drives the REAL
// respond path end-to-end (RespondPathProducerService -> `respond-path`
// queue -> RespondPathProcessor -> AgentRuntime -> AgentRunService) against
// real Postgres + Redis + BullMQ, same pattern as
// `conversation-memory.integration-spec.ts`. `LlmProvider`/`Embedder` are
// overridden with deterministic fakes (no real DeepSeek/OpenAI account in
// this environment) — everything else is real, including the actual
// `agent_runs` insert and its RLS policy.
//
// The T11 exhausted-retry error path (`onFailed()`'s own `recordRun()`
// call) is covered by unit tests (respond-path.processor.spec.ts) — BullMQ
// retry/backoff timing makes a real integration reproduction slow and
// timing-fragile for marginal additional coverage; `webhook-channel.
// integration-spec.ts` (Feature 2) already proves the retry/DLQ/ticket
// mechanics this path shares end-to-end.
//
// Requires real Postgres (pgvector) + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { RESPOND_TOOL_NAME } from '../../src/modules/agent/respond-tool-definition';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { Embedder } from '../../src/modules/llm/ports/embedder.port';
import { FakeEmbedder } from './fixtures/deterministic-embedding';
import { BspAdapter } from '../../src/modules/whatsapp/ports/bsp-adapter.port';
import { RecordingBspAdapter } from './fixtures/recording-bsp-adapter';
import { NoopRerankerAdapter } from '../../src/modules/retrieval/noop-reranker.adapter';
import { Reranker } from '../../src/modules/retrieval/ports/reranker.port';
import {
  LlmProvider,
  type LlmCompleteResult,
  type LlmToolRequest,
  type LlmToolResult,
} from '../../src/modules/llm/ports/llm-provider.port';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { TenantPolicyService } from '../../src/modules/onboarding/tenant-policy.service';
import {
  agentRuns,
  conversations,
  kbDocuments,
  tenants,
  tickets,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RetrievalIngestService } from '../../src/modules/retrieval/retrieval-ingest.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { estimateCostUsd } from '../../src/modules/telemetry/llm-cost';
import { RespondPathProducerService } from '../../src/modules/webhook/respond-path-producer.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';

/** Behaviour is selected per-call from the message text itself ("ESCALATE_ME", "DISTRESS_ME", "SILENT_MODEL") — keeps the fake stateless and safe to share across concurrent turns in the same test file. */
class ScriptedLlmProvider extends LlmProvider {
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async complete(): Promise<LlmCompleteResult> {
    throw new Error('not used in this integration test');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async completeWithTools(request: LlmToolRequest): Promise<LlmToolResult> {
    const userMessage = request.messages.find((m) => m.role === 'user');
    const text =
      typeof userMessage?.content === 'string' ? userMessage.content : '';
    const shouldEscalate = text.includes('ESCALATE_ME');
    const isDistress = text.includes('DISTRESS_ME');
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const citedChunkIds = [
      ...(systemMessage?.content.matchAll(/<chunk id="([^"]+)">/g) ?? []),
    ].map((match) => match[1]);

    // A model that never calls `respond` at all, in any form — the loop's
    // `no_respond_call` branch. Content is deliberately not a salvageable
    // respond payload, so the text-fallback path can't rescue it either.
    if (text.includes('SILENT_MODEL')) {
      return {
        content: 'thinking out loud, no tool call here',
        stopReason: 'end_turn',
        usage: { inputTokens: 42, outputTokens: 17 },
        toolCalls: [],
      };
    }

    const distressInput = {
      answer: "I'm sorry this happened — I'm getting a colleague to help you.",
      cited_chunk_ids: citedChunkIds,
      confidence: 0.9,
      escalate: true,
      escalation_reason: 'CUSTOMER_DISTRESS',
    };

    return {
      content: '',
      stopReason: 'end_turn',
      usage: { inputTokens: 42, outputTokens: 17 },
      toolCalls: [
        {
          id: `call-${randomUUID()}`,
          name: RESPOND_TOOL_NAME,
          input: isDistress
            ? distressInput
            : shouldEscalate
              ? {
                  answer: 'Let me get a human for this.',
                  cited_chunk_ids: [],
                  confidence: 0.1,
                  escalate: true,
                }
              : {
                  answer: 'Our support hours are 9am to 6pm.',
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

// 25s of headroom rather than 10s. A turn here does not start when
// enqueue() returns: it starts as a DELAYED BullMQ job (T10's debounce) and
// is picked up whenever the worker next wakes. That wake is not bounded by
// the debounce, so a 10s budget was leaving very little margin on a loaded
// machine for something that is pure queue latency, not agent behaviour.
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 25000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

describe('agent_runs telemetry (Feature 7 exit criteria, A8)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let respondPathProducer: RespondPathProducerService;
  let storageDir: string;
  const bspAdapter = new RecordingBspAdapter();

  const tenantId = randomUUID();

  beforeAll(async () => {
    // Shrink T10's 1.5s debounce for the suite — four sequential turns at
    // the production default is most of the per-test budget spent waiting.
    process.env.BURST_COALESCE_DEBOUNCE_MS = '50';
    storageDir = join(tmpdir(), `agent-runs-telemetry-test-${randomUUID()}`);
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
    respondPathProducer = moduleRef.get(RespondPathProducerService);
    const tenantPolicyService = moduleRef.get(TenantPolicyService);
    const retrievalIngest = moduleRef.get(RetrievalIngestService);

    await persistence.runAdminQuery((db) =>
      db
        .insert(tenants)
        .values({ id: tenantId, name: 'Agent Runs Test Tenant' }),
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
      content: Buffer.from('Our support hours are 9am to 6pm.'),
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

  /** Scoped to the specific customer's conversation, not just the tenant — two tests share one tenant, so an unscoped query would see both tests' rows. */
  async function agentRunsFor(phone: string) {
    return tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: agentRuns.id,
            tenantId: agentRuns.tenantId,
            conversationId: agentRuns.conversationId,
            ticketId: agentRuns.ticketId,
            status: agentRuns.status,
            escalationReason: agentRuns.escalationReason,
            escalationSource: agentRuns.escalationSource,
            escalationDetail: agentRuns.escalationDetail,
            confidence: agentRuns.confidence,
            inputTokens: agentRuns.inputTokens,
            outputTokens: agentRuns.outputTokens,
            costUsd: agentRuns.costUsd,
            latencyMs: agentRuns.latencyMs,
            spans: agentRuns.spans,
            promptVersion: agentRuns.promptVersion,
            errorMessage: agentRuns.errorMessage,
            createdAt: agentRuns.createdAt,
          })
          .from(agentRuns)
          .innerJoin(
            conversations,
            eq(agentRuns.conversationId, conversations.id),
          )
          .where(eq(conversations.customerPhone, phone)),
      tenantId,
    );
  }

  it('writes exactly one agent_runs row with status "success" and real token/span telemetry for a normal turn', async () => {
    const phone = '15550001111';
    await respondPathProducer.enqueue({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      providerMessageId: `wamid.${randomUUID()}`,
      from: phone,
      text: 'What are your support hours?',
    });

    await waitUntil(async () => (await agentRunsFor(phone)).length >= 1);
    const runs = await agentRunsFor(phone);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.status).toBe('success');
    expect(run.ticketId).toBeNull();
    expect(run.inputTokens).toBe(42);
    expect(run.outputTokens).toBe(17);
    // Asserted against the SAME pricing function the service uses, not
    // hardcoded as "> 0". The previous `> 0` quietly encoded an assumption
    // about which model LLM_MODEL names, and broke the moment the provider
    // swapped to a model llm-cost.ts has no rate for — flagging an
    // environment fact as a telemetry bug. What this must prove is that
    // cost_usd is DERIVED from the run's real token counts, which holds
    // whether or not the current model happens to be priced.
    expect(run.costUsd).toBeCloseTo(
      estimateCostUsd(moduleRef.get(AppConfigService).llmModel, 42, 17),
      9,
    );
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
    expect(run.promptVersion).toEqual(expect.any(String));
    // Normal turn: no loop branch gave up, so the A8 diagnostic stays null
    // rather than acquiring a placeholder.
    expect(run.escalationDetail).toBeNull();
    // P0.3 retrieval sub-spans must be written on the PRODUCTION path, not
    // only in the eval harness — this is the one assertion that proves the
    // AgentRuntime -> AgentRunService -> agent_runs.spans plumbing survives
    // the trip through the queue and the processor.
    // Only the phases that genuinely cost time here are asserted: the
    // accumulator drops any span that stayed at 0 (deliberately — "rerank was
    // off" must not look like "rerank took 0ms"), and the scripted LLM
    // provider returns without any I/O, so `llmMs` legitimately rounds to 0
    // and disappears. The fixture embedder is deliberately non-instant so the
    // retrieval sub-span plumbing is observable end to end.
    expect(run.spans.retrievalMs).toEqual(expect.any(Number));
    expect(run.spans.retrievalEmbedMs).toEqual(expect.any(Number));
    expect(run.spans.retrievalEmbedMs!).toBeLessThanOrEqual(
      run.spans.retrievalMs!,
    );
  });

  it('writes exactly one agent_runs row with status "escalated" and the real ticketId when the turn escalates', async () => {
    const phone = '15550002222';
    await respondPathProducer.enqueue({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      providerMessageId: `wamid.${randomUUID()}`,
      from: phone,
      text: 'ESCALATE_ME please',
    });

    await waitUntil(async () => (await agentRunsFor(phone)).length >= 1);
    const runs = await agentRunsFor(phone);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.status).toBe('escalated');
    expect(run.ticketId).toEqual(expect.any(String));
    expect(run.escalationReason).toEqual(expect.any(String));
  });

  // CUSTOMER_DISTRESS is the newest member of D13's reason list (L0 v3) and
  // the only one that fires on TONE rather than on confidence or an error.
  // It has to survive the whole trip — respond payload -> AgentTurnResult ->
  // ticket row -> agent_runs row — without being remapped to
  // CONFIDENCE_BELOW_THRESHOLD or rejected by a stale allow-list on the way.
  it('carries a CUSTOMER_DISTRESS escalation through to a correctly labelled ticket and run row', async () => {
    const phone = '15550003333';
    await respondPathProducer.enqueue({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      providerMessageId: `wamid.${randomUUID()}`,
      from: phone,
      text: 'DISTRESS_ME this is the third time this has gone wrong',
    });

    await waitUntil(async () => (await agentRunsFor(phone)).length >= 1);
    const [run] = await agentRunsFor(phone);

    expect(run.status).toBe('escalated');
    expect(run.escalationReason).toBe('CUSTOMER_DISTRESS');
    // Tone, not a loop failure: the model decided, so the source is
    // agent_decision and there is no loop-branch detail to record.
    expect(run.escalationSource).toBe('agent_decision');
    expect(run.escalationDetail).toBeNull();

    const [ticket] = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: tickets.id,
            escalationReason: tickets.escalationReason,
            conversationId: tickets.conversationId,
          })
          .from(tickets)
          .where(eq(tickets.id, run.ticketId!)),
      tenantId,
    );
    expect(ticket.escalationReason).toBe('CUSTOMER_DISTRESS');
    expect(ticket.conversationId).toBe(run.conversationId);
  });

  // The A8 diagnostic's whole purpose is being readable in production. Until
  // now it was computed by AgentRuntime and dropped by the processor, so a
  // turn lost to the loop was indistinguishable from any other LLM_ERROR
  // once it reached the database.
  it('persists the loop-forced escalation_detail (no_respond_call) on the run row', async () => {
    const phone = '15550004444';
    await respondPathProducer.enqueue({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      providerMessageId: `wamid.${randomUUID()}`,
      from: phone,
      text: 'SILENT_MODEL what are your hours?',
    });

    await waitUntil(async () => (await agentRunsFor(phone)).length >= 1);
    const [run] = await agentRunsFor(phone);

    expect(run.status).toBe('escalated');
    // The product-level reason stays the coarse D13 value...
    expect(run.escalationReason).toBe('LLM_ERROR');
    expect(run.escalationSource).toBe('error_forced');
    // ...and the engineering-level one says WHICH branch gave up, which is
    // the only thing that makes "we lost N turns yesterday" actionable.
    expect(run.escalationDetail).toBe('no_respond_call');
  });
});
