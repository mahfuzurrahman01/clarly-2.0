// A0/D5: Gemini adapter for the Embedder port. Selected via
// EMBEDDING_PROVIDER=gemini (see llm.module.ts's factory) — the port exists
// precisely so an embedding vendor swap is an adapter change and nothing
// else, so no caller of `Embedder` changes because of this file.
//
// This is now the ROLLBACK path — EMBEDDING_PROVIDER defaults to 'qwen'
// (self-hosted vLLM), because this adapter shares GEMINI_API_KEY with the
// chat provider and a KB ingest burst therefore contends with live chat
// traffic for one quota. Kept working, and kept covered, so reverting is a
// config flip plus a re-embed rather than a code change under pressure.
//
// `outputDimensionality` is pinned to EMBEDDING_DIMENSIONS (1024) because
// kb_chunks.embedding is `vector(1024)` (migration 0023). Gemini's native
// output is 3072, so omitting this would produce vectors Postgres rejects on
// insert. Gemini's MRL truncation matches whatever width the vLLM model
// emits, which is what lets one schema serve both adapters.
//
// Google's REST endpoint is called directly rather than through a vendor
// SDK — the request is a single POST with no streaming, no auth dance, and
// no pagination, so an SDK dependency would buy nothing here.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import { Embedder, type EmbeddingVector } from './ports/embedder.port';

// Bumped manually whenever the embedding strategy/model changes; D5's point
// is that a version bump becomes a background re-embed job (A1), not a
// schema rebuild, because every stored chunk carries its embedding version.
// 'g1' rather than 'v1' so Gemini-embedded chunks are distinguishable from
// the OpenAI adapter's — the two vector spaces are NOT comparable, and
// mixing them in one index silently degrades retrieval quality.
const EMBEDDING_VERSION = 'g1';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiEmbedResponse {
  embedding?: { values?: number[] };
  error?: { message?: string };
}

@Injectable()
export class GeminiEmbedder extends Embedder {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(config: AppConfigService) {
    super();
    this.apiKey = config.geminiApiKey ?? '';
    this.model = config.embeddingModel;
    this.dimensions = config.embeddingDimensions;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const response = await fetch(
      `${GEMINI_API_BASE}/models/${this.model}:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          // RETRIEVAL_DOCUMENT tells Gemini this vector is being stored for
          // later retrieval rather than used as a query, which materially
          // improves recall on the asymmetric query->document matching A1
          // does. Query-side embedding would use RETRIEVAL_QUERY.
          taskType: 'RETRIEVAL_DOCUMENT',
          outputDimensionality: this.dimensions,
        }),
      },
    );

    // Never interpolate the response body into the thrown message — it can
    // echo back the API key on some Google error shapes.
    if (!response.ok) {
      throw new Error(
        `Gemini embeddings API returned HTTP ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as GeminiEmbedResponse;
    const values = body.embedding?.values;
    if (!values || values.length === 0) {
      throw new Error('Gemini embeddings API returned no embedding data');
    }

    // A dimension mismatch here would otherwise surface as an opaque
    // Postgres "expected N dimensions" error three layers down, inside the
    // ingest worker, long after the cause.
    if (values.length !== this.dimensions) {
      throw new Error(
        `Gemini embeddings API returned ${values.length} dimensions, expected ${this.dimensions}`,
      );
    }

    return {
      values,
      embeddingModel: this.model,
      embeddingVersion: EMBEDDING_VERSION,
    };
  }
}
