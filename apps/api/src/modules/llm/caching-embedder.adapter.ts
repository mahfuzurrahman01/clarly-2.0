// Phase 5 item 6 / TODOS B2 (2026-09-22): the query-embedding cache.
//
// MEASUREMENT FIRST. On every F27 eval corpus the retrieval p95 misses its
// 400ms budget at 3.4-5.9s, and the phase breakdown attributes 80-92% of it to
// one thing: the HTTP round trip to the remote embedding host (`httpTtfbMs`,
// which is round trip + host compute on a warm undici pool — see
// EmbedderCallTimings). The pgvector pass and the reranker are not the problem,
// and rerank is already off by default. So the only fix that does not require
// moving the host is to stop making the call.
//
// WHAT THIS DOES AND DOES NOT FIX. A cache removes the round trip for a REPEATED
// query, nothing else. Gulf retail traffic repeats heavily at the head — "بكم
// هذا؟", "كم التوصيل؟", "فيه ضمان؟" arrive hundreds of times a day across a
// tenant's customers — so the head of the distribution goes to ~0ms while a
// first-time question still pays the full round trip. It is therefore a
// complement to relocating the embedding host (the decision in
// docs/decisions/B2-retrieval-latency.md), never a replacement: a cold cache
// and a long-tail question are exactly the pre-cache numbers.
//
// SCOPE — queries only, never ingest. Entries are refused above
// MAX_CACHEABLE_TEXT_LENGTH, which keeps KB chunks (the ingest path, thousands
// of long texts, each ~22KB of vector) out of a bounded in-process map that
// exists for short, repeated questions.
//
// MODEL SWAPS. The cache is process-local and the model is chosen by config at
// boot (EMBEDDING_PROVIDER), so a deliberate swap restarts the process and
// takes the cache with it — there is no window where a vector from the previous
// model can be served. The TTL below is the backstop for the silent case: the
// same version tag served by a re-deployed or re-quantized host.
//
// TENANT SAFETY. An embedding is a pure function of (text, model) — it carries
// no tenant data and no retrieval result, so a shared cache leaks nothing
// across tenants. What is tenant-scoped is the SEARCH that consumes the vector,
// and that is untouched: `PgVectorStore.search()` still runs inside the
// tenant's own RLS transaction with the tenant's own document scope.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { Clock } from '../core/clock/clock';
import { Embedder, type EmbeddingVector } from './ports/embedder.port';

/** Head-of-distribution questions are short. A KB chunk is not, and must never enter this cache. */
export const MAX_CACHEABLE_TEXT_LENGTH = 512;
/** ~2560 floats per entry ≈ 20KB in V8, so 1,000 entries ≈ 20MB — the whole head of a busy tenant's question distribution for the price of one connection pool. */
export const MAX_CACHE_ENTRIES = 1_000;
/** The backstop described in the header: a host re-deployed under the same version tag. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  vector: EmbeddingVector;
  expiresAtMs: number;
}

/**
 * Decorator around the configured Embedder. Injected under the `Embedder` token
 * itself, so every consumer (RetrievalSearchService, the ingest path, the
 * forbidden-topic check) gets it without knowing it exists.
 */
@Injectable()
export class CachingEmbedder extends Embedder {
  /** Insertion-ordered, which is what makes the eviction below a real LRU: a hit re-inserts. */
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: Embedder,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async embed(text: string): Promise<EmbeddingVector> {
    if (text.length > MAX_CACHEABLE_TEXT_LENGTH) {
      return this.inner.embed(text);
    }

    const nowMs = this.clock.nowMs();
    const key = cacheKey(text);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAtMs > nowMs) {
      // Re-insert to move this key to the end of the insertion order — the
      // eviction below drops the oldest, so a hot query is never evicted while
      // a colder one survives.
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.hits += 1;
      // Deliberately returned WITHOUT `timings`: no HTTP call happened, and
      // reporting the original call's numbers would make the retrieval
      // breakdown claim a round trip this turn never paid for.
      return { ...cached.vector, timings: undefined };
    }

    this.misses += 1;
    const vector = await this.inner.embed(text);
    this.entries.set(key, {
      vector,
      expiresAtMs: nowMs + CACHE_TTL_MS,
    });
    this.evictOverflow();
    return vector;
  }

  /** Diagnostic for the B2 before/after and for T18 platform health — never branched on. */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }

  private evictOverflow(): void {
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
      this.logger.debug(
        `Embedding cache evicted an entry (size cap ${MAX_CACHE_ENTRIES})`,
        CachingEmbedder.name,
      );
    }
  }
}

/**
 * Whitespace-folded and case-folded: "كم سعره؟" and "كم  سعره؟ " are the same
 * question to a customer and produce near-identical vectors, so treating them
 * as one key costs nothing and raises the hit rate on real typing. NOT
 * normalized further (no dialect folding, no diacritic stripping) — those
 * change what the embedding means, which is the retrieval quality this cache
 * must leave exactly as it found it.
 */
function cacheKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
