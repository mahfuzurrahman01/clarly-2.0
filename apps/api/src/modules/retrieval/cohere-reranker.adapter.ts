// A1/D4: the real Cohere adapter — Cohere IS the decided rerank vendor
// (open decision #2, resolved), not a pending choice, so this is built for
// real even though no Cohere account is provisioned in this environment
// (same reasoning as DeepSeek/OpenAI in Slice 1 — see
// docs/decisions/F3-agent-core.md). Bound only when `RERANK_PROVIDER=cohere`;
// `NoopRerankerAdapter` is the safe default otherwise. Plain `fetch`
// against Cohere's REST API rather than pulling in the `cohere-ai` SDK for
// a single endpoint.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import {
  Reranker,
  type RerankCandidate,
  type RerankResult,
} from './ports/reranker.port';

const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
const COHERE_MODEL = 'rerank-v3.5';

interface CohereRerankResponse {
  results: Array<{ index: number; relevance_score: number }>;
}

@Injectable()
export class CohereRerankerAdapter extends Reranker {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfigService) {
    super();
    this.apiKey = config.cohereApiKey;
    this.timeoutMs = config.rerankTimeoutMs;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    try {
      return await this.requestRerank(query, candidates, topN);
    } catch (error) {
      // AbortSignal.timeout() rejects with a DOMException named TimeoutError,
      // on the request or while the body is still streaming. Renamed so the
      // caller's degradation log says what happened (RERANK_TIMEOUT_MS).
      if (isTimeoutError(error)) {
        throw new Error(
          `Cohere rerank timed out after ${this.timeoutMs}ms (RERANK_TIMEOUT_MS)`,
        );
      }
      throw error;
    }
  }

  /**
   * Bounded by RERANK_TIMEOUT_MS. Without a bound, a stalled call (~10.5s on
   * a few percent of calls, cycle 3b) was paid in full by the customer's turn;
   * with it, the caller serves the RRF-fused order instead.
   */
  private async requestRerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankResult[]> {
    const response = await fetch(COHERE_RERANK_URL, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COHERE_MODEL,
        query,
        documents: candidates.map((candidate) => candidate.content),
        top_n: Math.min(topN, candidates.length),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Cohere rerank request failed: ${response.status} ${await response.text()}`,
      );
    }

    const body = (await response.json()) as CohereRerankResponse;

    return body.results.map((result) => {
      const candidate = candidates[result.index];
      if (!candidate) {
        throw new Error(
          `Cohere rerank returned an out-of-range document index: ${result.index}`,
        );
      }
      return { id: candidate.id, score: result.relevance_score };
    });
  }
}

/** DOMException is not an Error subclass in every runtime, so the name is read structurally. */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}
