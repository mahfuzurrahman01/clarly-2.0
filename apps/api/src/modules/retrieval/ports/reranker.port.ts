// D4: "rerank top-20 to top-5," Cohere is the resolved vendor (open
// decision #2, docs/AI_PIPELINE_PLAN.md). Port-shaped the same way as
// LlmProvider/Embedder/VectorStore — an abstract class doubling as its own
// DI token, so a reranker swap or a per-tenant on/off (D4's own "behind a
// per-tenant flag") is a binding choice, never a call-site branch.
export interface RerankCandidate {
  id: string;
  content: string;
}

export interface RerankResult {
  id: string;
  /** Relevance score, ranked descending — vendor-specific scale, only meaningful for ordering within this call. */
  score: number;
}

export abstract class Reranker {
  abstract rerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankResult[]>;
}
