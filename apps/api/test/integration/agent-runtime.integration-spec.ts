// Feature 3/A4: proves AgentModule's DI graph (7 module imports —
// PromptModule, LlmModule, RetrievalModule, GuardrailModule,
// ToolRegistryModule, ToolExecutionModule, CoreModule) actually resolves
// and that AgentRuntime.respond() drives real RetrievalModule/
// GuardrailModule logic against a real Postgres — something the unit
// suite (agent-runtime.spec.ts, hand-rolled mocks for every dependency)
// can't catch a misconfigured provider binding for. `LlmProvider` and
// `Embedder` are overridden with deterministic fakes (no real
// DeepSeek/OpenAI account in this environment, see
// docs/decisions/F3-agent-core.md) — everything else in the chain is real.
//
// Requires real Postgres (pgvector extension enabled) + Redis. Run via
// `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { AgentModule } from '../../src/modules/agent/agent.module';
import { AgentRuntime } from '../../src/modules/agent/agent-runtime';
import { RESPOND_TOOL_NAME } from '../../src/modules/agent/respond-tool-definition';
import { CoreModule } from '../../src/modules/core/core.module';
import { Embedder } from '../../src/modules/llm/ports/embedder.port';
import { FakeEmbedder } from './fixtures/deterministic-embedding';
import { NoopRerankerAdapter } from '../../src/modules/retrieval/noop-reranker.adapter';
import { Reranker } from '../../src/modules/retrieval/ports/reranker.port';
import {
  LlmProvider,
  type LlmCompleteResult,
  type LlmToolRequest,
  type LlmToolResult,
} from '../../src/modules/llm/ports/llm-provider.port';
import {
  kbDocuments,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RetrievalIngestService } from '../../src/modules/retrieval/retrieval-ingest.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

/** Always terminates via `respond` on the first call — enough to prove the wiring, not a real model. */
class ScriptedLlmProvider extends LlmProvider {
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async complete(): Promise<LlmCompleteResult> {
    throw new Error('not used in this integration test');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async completeWithTools(request: LlmToolRequest): Promise<LlmToolResult> {
    // Cite whatever L4 actually retrieved — read straight out of the
    // assembled system message rather than hardcoding a chunk ID this
    // fake can't know ahead of time (real IDs are generated at ingest
    // time). Proves the prompt really carries retrieved content through,
    // not just that the loop mechanically terminates.
    const systemMessage = request.messages.find(
      (message) => message.role === 'system',
    );
    const citedChunkIds = [
      ...(systemMessage?.content.matchAll(/<chunk id="([^"]+)">/g) ?? []),
    ].map((match) => match[1]);

    return {
      content: '',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [
        {
          id: 'call-1',
          name: RESPOND_TOOL_NAME,
          input: {
            answer: 'Shipping takes 3-5 business days.',
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

describe('AgentRuntime (Feature 3/A4) — DI wiring + real retrieval/guardrail integration', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let agentRuntime: AgentRuntime;
  let storageDir: string;

  const tenantA = randomUUID();

  beforeAll(async () => {
    storageDir = join(tmpdir(), `agent-runtime-test-${randomUUID()}`);
    process.env.KB_LOCAL_STORAGE_DIR = storageDir;

    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        AgentModule,
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
      .overrideProvider(LlmProvider)
      .useClass(ScriptedLlmProvider)
      .compile();

    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    agentRuntime = moduleRef.get(AgentRuntime);

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([{ id: tenantA, name: 'A4 Test Tenant' }]),
    );

    const kbDocumentId = randomUUID();
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(kbDocuments).values({
          id: kbDocumentId,
          tenantId: tenantA,
          filename: 'shipping.txt',
          storageKey: `${tenantA}/${kbDocumentId}`,
          mimeType: 'text/plain',
          sizeBytes: 0,
          status: 'uploaded',
        }),
      tenantA,
    );

    const retrievalIngest = moduleRef.get(RetrievalIngestService);
    await retrievalIngest.ingestDocument({
      tenantId: tenantA,
      kbDocumentId,
      content: Buffer.from('Shipping takes 3-5 business days.'),
      mimeType: 'text/plain',
    });
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantA)),
    );
    await moduleRef.close();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.KB_LOCAL_STORAGE_DIR;
  });

  it('resolves the full AgentModule DI graph and produces a non-escalated answer for an indexed tenant', async () => {
    const result = await agentRuntime.respond({
      tenantId: tenantA,
      conversationSummary: null,
      recentMessages: [],
      currentMessage: 'How long does shipping take?',
      tenantPolicy: {
        tonePersonaOverride: null,
        forbiddenTopics: [],
        confidenceThreshold: 0.5,
        rerankEnabled: false,
      },
    });

    expect(result.answer).toBe('Shipping takes 3-5 business days.');
    expect(result.escalate).toBe(false);
  });

  it('D12: a real forbidden-topic match (via the real embedding-similarity check) escalates before ever reaching the scripted LLM', async () => {
    const result = await agentRuntime.respond({
      tenantId: tenantA,
      conversationSummary: null,
      recentMessages: [],
      currentMessage: 'refunds',
      tenantPolicy: {
        tonePersonaOverride: null,
        forbiddenTopics: ['refunds'],
        confidenceThreshold: 0.5,
        rerankEnabled: false,
      },
    });

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('FORBIDDEN_TOPIC');
  });

  it('D3/A1: an empty-KB tenant escalates KB_NOT_INDEXED through the real retrieval path', async () => {
    const emptyTenant = randomUUID();
    await persistence.runAdminQuery((db) =>
      db
        .insert(tenants)
        .values([{ id: emptyTenant, name: 'A4 Empty KB Tenant' }]),
    );

    const result = await agentRuntime.respond({
      tenantId: emptyTenant,
      conversationSummary: null,
      recentMessages: [],
      currentMessage: 'anything',
      tenantPolicy: {
        tonePersonaOverride: null,
        forbiddenTopics: [],
        confidenceThreshold: 0.5,
        rerankEnabled: false,
      },
    });

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('KB_NOT_INDEXED');

    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, emptyTenant)),
    );
  });
});
