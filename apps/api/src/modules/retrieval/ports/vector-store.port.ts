// D3: VectorStore port. Exit-trigger requirement: "nothing outside RetrievalModule
// may import pgvector types." This contract is storage-agnostic (plain number[]
// vectors, no pgvector-specific types) so migrating to Qdrant per-tenant
// collections later is an adapter swap behind this same port. Chunking, ingest,
// hybrid search, and rerank land in the A1-proper pass; this file is the contract
// only.

export interface VectorStoreChunk {
  id: string;
  tenantId: string;
  content: string;
  embedding: number[];
  /** D5 metadata, carried through so re-embeds are traceable per chunk. */
  embeddingModel: string;
  embeddingVersion: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStoreSearchQuery {
  tenantId: string;
  queryEmbedding: number[];
  /** D4: the lexical half of hybrid search (Postgres tsvector) needs the raw text, not just its embedding. */
  queryText: string;
  topK: number;
  /**
   * F9 per-agent scoping: restrict retrieval to these documents.
   *
   * Undefined or empty means the tenant's whole knowledge base — the default
   * every agent had before scoping existed, and the safe reading of "the
   * tenant has not chosen yet".
   */
  kbDocumentIds?: string[];
  /**
   * D5: filter by embedding version so old-version chunks from a re-embed
   * migration don't pollute search results. Undefined means no filter (backwards
   * compatible), but every production caller should pass the current version.
   */
  embeddingVersion?: string;
  filter?: Record<string, unknown>;
}

export interface VectorStoreSearchResult {
  chunkId: string;
  content: string;
  /** Similarity/relevance score, ranked descending. Fusion/rerank happens above this port. */
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * P0.3 diagnostics. D4's hybrid search is three distinct pieces of work behind
 * one `search()` call — an ANN/vector pass, a lexical pass, and RRF fusion —
 * and collapsing them into one number cannot answer "is the pgvector index
 * doing its job?". Storage-agnostic despite the names: any hybrid store has a
 * dense pass, a sparse pass, and a fusion step.
 *
 * Optional on the response for the same reason as EmbedderCallTimings: a
 * diagnostic, not part of the D3 contract.
 */
export interface VectorStoreSearchTimings {
  /** ms for the dense/ANN pass (pgvector `<=>` ordering). */
  vectorQueryMs: number;
  /** ms for the sparse/lexical pass (tsvector `@@` + ts_rank). */
  lexicalQueryMs: number;
  /** ms for in-process fusion + row mapping. Expected to be ~0; a non-trivial value means the candidate set grew. */
  fusionMs: number;
  /** Total inside search(), including transaction setup and the per-tenant GUC round trip that the two passes share. */
  totalMs: number;
}

export interface VectorStoreSearchResponse {
  results: VectorStoreSearchResult[];
  timings?: VectorStoreSearchTimings;
}

/**
 * D3 port. Abstract class so it doubles as its own NestJS DI token — the pgvector
 * implementation binds via `{ provide: VectorStore, useClass: PgVectorStore }` in
 * the A1-proper pass, and every consumer injects this type only, never pgvector
 * types directly.
 */
export abstract class VectorStore {
  abstract upsertChunks(chunks: VectorStoreChunk[]): Promise<void>;

  /**
   * Removes every chunk belonging to one KB document. Part of the port
   * rather than a pgvector detail because deletion is a retrieval-contract
   * concern: a store that cannot forget a document lets a deleted document
   * keep answering customers. Returns the number of chunks removed so the
   * caller can log what actually disappeared.
   */
  abstract deleteByDocument(
    tenantId: string,
    kbDocumentId: string,
  ): Promise<number>;
  /** Returns a response object rather than a bare array so per-phase timings can ride along without a second call or adapter-held state (P0.3). */
  abstract search(
    query: VectorStoreSearchQuery,
  ): Promise<VectorStoreSearchResponse>;
}
