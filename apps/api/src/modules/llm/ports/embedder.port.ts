// A0/D5: Embedder port. Deliberately provider-agnostic — D5 picks OpenAI
// text-embedding-3-small, but nothing in this contract encodes that choice, so an
// embedding vendor swap is an adapter change. The OpenAI adapter lands in the
// A0-proper pass; this file is the contract only.

/**
 * P0.3 diagnostics. The embedder is a REMOTE call (EMBEDDING_BASE_URL) sitting
 * on the respond path's critical section, and "the embed step took 300ms" is
 * not actionable on its own — 300ms of host compute is a model problem, 300ms
 * before the first response byte on a warm connection is a transport problem,
 * and the two have opposite fixes (smaller model vs colocation).
 *
 * Split at the only boundary `fetch` actually exposes: headers-received
 * (`await fetch(...)` resolving) versus body-read/parse (`await res.json()`).
 * Node's undici pools connections, so on a warm pool `httpTtfbMs` is
 * round-trip + host compute with no handshake in it; a cold pool adds
 * DNS/TCP/TLS to the same number, which is why the eval prints this next to
 * an out-of-band `curl -w` baseline rather than in isolation.
 *
 * Optional on purpose: it is a diagnostic, not part of the D5 contract, so an
 * adapter that cannot measure it (or an in-process embedder, which is where
 * this is heading) simply omits it.
 */
export interface EmbedderCallTimings {
  /** ms from issuing the request to response headers arriving. Includes the remote host's own compute. */
  httpTtfbMs: number;
  /** ms spent reading + JSON-parsing the response body after headers arrived. ~22KB per 1024-dim vector, so not free. */
  httpBodyMs: number;
  /** Total wall clock inside the adapter for this call, including request serialization. */
  totalMs: number;
}

export interface EmbeddingVector {
  values: number[];
  /** D5: model identifier, e.g. "text-embedding-3-small". Persisted alongside chunks. */
  embeddingModel: string;
  /** D5: version tag so a model swap is a background re-embed, not a rebuild. */
  embeddingVersion: string;
  /** P0.3: per-call HTTP breakdown, when the adapter can measure it. Carried on the value rather than held as adapter state so concurrent calls can never read each other's numbers. */
  timings?: EmbedderCallTimings;
}

/**
 * A0/D5 port. Abstract class so it doubles as its own NestJS DI token, same
 * convention as `LlmProvider`.
 */
export abstract class Embedder {
  abstract embed(text: string): Promise<EmbeddingVector>;
}
