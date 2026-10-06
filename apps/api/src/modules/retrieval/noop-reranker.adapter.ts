// A1/D4: the default Reranker binding — `RERANK_PROVIDER=none` (this
// environment's default; no Cohere account provisioned, see
// docs/decisions/F3-agent-core.md). Unlike LlmProvider/Embedder, rerank is
// genuinely optional per D4 ("rerank top-20 to top-5" is a quality
// improvement, not a correctness requirement — hybrid search's RRF fusion
// already produces a usable ranking on its own), so the safe default is a
// real no-op adapter, not a placeholder credential that would 401.
import { Injectable } from '@nestjs/common';
import {
  Reranker,
  type RerankCandidate,
  type RerankResult,
} from './ports/reranker.port';

@Injectable()
export class NoopRerankerAdapter extends Reranker {
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract a real reranker needs.
  async rerank(
    _query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankResult[]> {
    // Preserves the input order (already RRF-fused) and maps its implicit
    // rank onto a (0, 1] scale — matching Cohere's normalized
    // relevance_score range, since A5's D10 confidence formula (min of
    // model confidence and retrieval support score) needs a comparable
    // value regardless of which Reranker is bound.
    return candidates.slice(0, topN).map((candidate, index) => ({
      id: candidate.id,
      score: (candidates.length - index) / candidates.length,
    }));
  }
}
