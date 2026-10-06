// A1: the query-time counterpart to RetrievalIngestService. Embeds the
// query once (exposed on the result so callers — A4's loop, D12's
// forbidden-topic check — reuse it instead of re-embedding, per D12's own
// "marginal cost ~0ms, reuses the retrieval query embedding" claim), runs
// VectorStore.search() (PgVectorStore's RRF-fused hybrid search), then
// optionally reranks. Throws KBNotIndexed when nothing came back at all —
// A1's own verify step ("empty-KB tenant raises KBNotIndexed, not an empty
// answer").
import { Injectable } from '@nestjs/common';
import { KBNotIndexed } from '@repo/errors';
import { AppLoggerService } from '../core';
import { Clock } from '../core/clock/clock';
import { Embedder } from '../llm/ports/embedder.port';
import { Reranker } from './ports/reranker.port';
import { VectorStore } from './ports/vector-store.port';
import type { RetrievalPhaseTimings } from './retrieval-timings';

/** D4: rerank narrows top-20 (RRF fusion's breadth) to top-5. */
const FINAL_RESULT_COUNT = 5;
/** D4: hybrid search fetches a wider candidate set before reranking narrows it. */
const CANDIDATE_BREADTH = 20;

export interface RetrievedChunkResult {
  id: string;
  content: string;
  /** Normalized to (0, 1] regardless of which Reranker is bound (NoopRerankerAdapter or CohereRerankerAdapter) — see noop-reranker.adapter.ts's doc comment for why that normalization matters to A5's D10 formula. */
  score: number;
}

export interface RetrievalSearchResult {
  chunks: RetrievedChunkResult[];
  /** Reuse this for D12's forbidden-topic check — never re-embed the same message twice. */
  queryEmbedding: number[];
  /** P0.3: where the time went. Callers persist this (AgentRuntime -> agent_runs.spans) or print it (eval scorecard); nothing branches on it. */
  timings: RetrievalPhaseTimings;
}

export interface RetrievalSearchOptions {
  /**
   * Return zero chunks instead of throwing KBNotIndexed when nothing matched.
   * For a caller that can still answer without the knowledge base — the agent
   * loop of a tenant with enabled tools — and still needs `queryEmbedding` for
   * D12's forbidden-topic check. Off by default: A1's contract is unchanged
   * for every caller that does not opt in.
   */
  allowEmpty?: boolean;
}

@Injectable()
export class RetrievalSearchService {
  constructor(
    private readonly embedder: Embedder,
    private readonly vectorStore: VectorStore,
    private readonly reranker: Reranker,
    /** P0.3: phase timing. Injected per the Clock port's contract rather than calling Date.now() inline. */
    private readonly clock: Clock,
    /** Only used to make a rerank degradation loud — see rerankOrDegrade(). */
    private readonly logger: AppLoggerService,
  ) {}

  /** `rerankEnabled` is the caller-supplied value of tenant_policy.rerank_enabled (D4's per-tenant flag) — this service doesn't read tenant_policy itself, staying input-driven like PromptModule/GuardrailModule. */
  async search(
    tenantId: string,
    queryText: string,
    rerankEnabled: boolean,
    /** F9: the documents this agent may answer from. Empty/omitted = the whole knowledge base. */
    kbDocumentIds?: string[],
    options: RetrievalSearchOptions = {},
  ): Promise<RetrievalSearchResult> {
    const startMs = this.clock.nowMs();

    const queryEmbedding = await this.embedder.embed(queryText);
    const embedDoneMs = this.clock.nowMs();

    const searchResponse = await this.vectorStore.search({
      tenantId,
      queryEmbedding: queryEmbedding.values,
      queryText,
      topK: CANDIDATE_BREADTH,
      kbDocumentIds,
      embeddingVersion: queryEmbedding.embeddingVersion,
    });
    const storeDoneMs = this.clock.nowMs();
    const candidates = searchResponse.results;

    // P0.3: KBNotIndexed throws before timings can be returned, and that is
    // deliberate — an empty index is a correctness signal, not a latency
    // sample, and the eval already records those turns separately.
    if (candidates.length === 0 && !options.allowEmpty) {
      throw new KBNotIndexed(
        `Tenant ${tenantId} has no indexed knowledge-base content for this query`,
      );
    }

    const contentById = new Map(
      candidates.map((candidate) => [candidate.chunkId, candidate.content]),
    );

    // D4: "rerank behind a per-tenant flag." When a tenant has opted out,
    // skip the reranker call entirely (even if RERANK_PROVIDER=cohere
    // globally) rather than call it and discard the result — the whole
    // point of the flag is avoiding the extra network round-trip for
    // tenants where it threatens the T9 latency budget.
    // Nothing to rank on an allowed-empty result: skip the reranker's round trip.
    const shouldRerank = rerankEnabled && candidates.length > 0;
    const reranked = shouldRerank
      ? await this.rerankOrDegrade(queryText, candidates)
      : fusedOrder(candidates);

    const endMs = this.clock.nowMs();
    const storeTimings = searchResponse.timings;

    return {
      chunks: reranked.map((result) => ({
        id: result.id,
        content: contentById.get(result.id) ?? '',
        score: result.score,
      })),
      queryEmbedding: queryEmbedding.values,
      timings: {
        embedMs: embedDoneMs - startMs,
        embedHttpTtfbMs: queryEmbedding.timings?.httpTtfbMs,
        embedHttpBodyMs: queryEmbedding.timings?.httpBodyMs,
        // A store that reports no timings still contributes its wall clock to
        // storeMs, so the phases always add up even behind a different adapter.
        vectorQueryMs: storeTimings?.vectorQueryMs ?? 0,
        lexicalQueryMs: storeTimings?.lexicalQueryMs ?? 0,
        fusionMs: storeTimings?.fusionMs ?? 0,
        storeMs: storeDoneMs - embedDoneMs,
        // Measured from the store call finishing, so it captures the reranker
        // round trip and nothing else — the rerank flag's cost is the reason
        // D4 made it per-tenant, and this is what proves or disproves it.
        rerankMs: shouldRerank ? endMs - storeDoneMs : 0,
        totalMs: endMs - startMs,
      },
    };
  }

  /**
   * D4's rerank pass, made non-fatal.
   *
   * Rerank is a QUALITY step layered on an already-usable ranking: the
   * candidate list handed to it is RRF-fused, and that fused order is
   * exactly what a tenant with `rerank_enabled = false` is served (and what
   * `NoopRerankerAdapter` returns). So a transient reranker failure — a
   * Cohere 429, a DNS blip, a timeout — has a strictly better answer
   * available than failing.
   *
   * Before this, the exception propagated out of `search()`, out of
   * `AgentRuntime.respond()` (it isn't a `KBNotIndexed`, so the runtime
   * rethrows it), and out of `RespondPathProcessor.process()`, where BullMQ
   * retried the WHOLE turn up to three times — three more LLM calls, three
   * more retrieval passes — before ending in a `TOOL_FAILURE` ticket. A
   * customer waited on a human because a ranking refinement was rate-limited.
   * Observed for real: a live Cohere 429 turned two green integration suites
   * red by way of exhausted respond-path retries.
   *
   * Logged at ERROR, not silently swallowed: degradation must stay visible,
   * because a persistent cause (a revoked key 401ing every call) looks
   * identical to a blip from inside a single turn and would otherwise mean
   * every tenant silently loses rerank forever.
   */
  private async rerankOrDegrade(
    queryText: string,
    candidates: Array<{ chunkId: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>> {
    try {
      return await this.reranker.rerank(
        queryText,
        candidates.map((candidate) => ({
          id: candidate.chunkId,
          content: candidate.content,
        })),
        FINAL_RESULT_COUNT,
      );
    } catch (error) {
      this.logger.error(
        `rerank failed, degrading this query to the RRF-fused order (the same ranking a rerank-disabled tenant gets): ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        'RetrievalSearchService',
      );
      return fusedOrder(candidates);
    }
  }
}

/** The RRF-fused order, truncated to D4's top-5 and mapped onto the same (0, 1] scale every Reranker returns — A5's D10 confidence gate compares against it, so the scale must not depend on which path produced the ranking. Shared verbatim by the rerank-disabled branch and the rerank-failure fallback so the two can never drift apart. */
function fusedOrder(
  candidates: Array<{ chunkId: string; content: string }>,
): Array<{ id: string; score: number }> {
  return candidates.slice(0, FINAL_RESULT_COUNT).map((candidate, index) => ({
    id: candidate.chunkId,
    score: (candidates.length - index) / candidates.length,
  }));
}
