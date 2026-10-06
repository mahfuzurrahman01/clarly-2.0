// P0.3 (docs/decisions/A0-production-readiness-plan.md): the retrieval phase
// breakdown.
//
// WHY THIS EXISTS: retrieval p95 fails its <400ms bar on every eval run
// (676ms / 768ms / 1256ms across three consecutive runs) and the whole path
// was covered by a single `retrievalMs` span, so "the embedding round trip is
// slow", "the pgvector query is slow" and "the network to the embedding host
// is slow" were indistinguishable. Optimising against an unattributable
// number is guesswork; this type is what makes the choice evidence-driven.
//
// It is a plain data shape with no behaviour so it can be shared verbatim by
// the three consumers that need it — RetrievalSearchService (producer),
// AgentRuntime's telemetry (persists it into agent_runs.spans) and the eval
// scorecard — instead of each growing its own parallel notion of a phase.

/**
 * Wall-clock ms per phase of one RetrievalSearchService.search() call. The
 * phases are disjoint and sum to slightly less than `totalMs`; the remainder
 * is in-process glue (building the content map, mapping results) that is not
 * worth its own span.
 */
export interface RetrievalPhaseTimings {
  /** The query-embedding call — a REMOTE HTTP round trip to EMBEDDING_BASE_URL, and the prime suspect. */
  embedMs: number;
  /**
   * Of `embedMs`, how long until the embedding host's response headers
   * arrived. On a warm undici connection pool this is round-trip + host
   * compute with no TLS handshake in it, so comparing it against an
   * out-of-band `curl -w` baseline for a trivial endpoint on the same host
   * (e.g. GET /v1/models) separates transport from the model's own work.
   * Undefined when the bound Embedder does not report it.
   */
  embedHttpTtfbMs?: number;
  /** Of `embedMs`, time spent reading + parsing the response body (~22KB for one 1024-dim vector). */
  embedHttpBodyMs?: number;
  /** The dense/pgvector pass inside the store. */
  vectorQueryMs: number;
  /** The lexical/tsvector pass inside the store. */
  lexicalQueryMs: number;
  /** RRF fusion + row mapping inside the store. */
  fusionMs: number;
  /** Everything inside VectorStore.search(), including connection acquisition and the per-tenant GUC round trip — always ≥ the three phases above. */
  storeMs: number;
  /** The rerank call, or 0 when the tenant has rerank disabled (D4's per-tenant flag). */
  rerankMs: number;
  /** Total wall clock for search(). This is the number that must come in under 400ms. */
  totalMs: number;
}

/** Zeroed timings, for the paths that must still return a well-formed shape. */
export function emptyRetrievalPhaseTimings(): RetrievalPhaseTimings {
  return {
    embedMs: 0,
    vectorQueryMs: 0,
    lexicalQueryMs: 0,
    fusionMs: 0,
    storeMs: 0,
    rerankMs: 0,
    totalMs: 0,
  };
}
