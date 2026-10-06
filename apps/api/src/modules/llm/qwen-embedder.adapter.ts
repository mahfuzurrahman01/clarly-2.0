// A0/D5: vLLM adapter for the Embedder port, selected via
// EMBEDDING_PROVIDER=qwen (see llm.module.ts's factory). Talks the
// OpenAI-compatible `/v1/embeddings` surface that vLLM serves, so nothing
// here is Qwen-specific beyond the defaults — any vLLM-hosted embedding
// model works by pointing EMBEDDING_BASE_URL/EMBEDDING_MODEL elsewhere.
//
// Why this exists at all: the Gemini embedder shares GEMINI_API_KEY with the
// chat provider, so a KB ingest burst and live chat traffic compete for one
// quota and a 429 fails the turn (docs/HANDOFF.md). A self-hosted vLLM box
// has no per-minute cap — measured 20/20 concurrent requests at HTTP 200,
// zero 429s — which is the whole point of the swap.
//
// Two hard constraints of the served model, both verified against the live
// endpoint rather than assumed:
//
//  1. NO Matryoshka support. Passing `dimensions` returns HTTP 400
//     ("does not support Matryoshka embeddings"), so the vector width is
//     whatever the model natively emits and EMBEDDING_DIMENSIONS is a
//     validation target here, never a request parameter. Contrast with
//     GeminiEmbedder, which DOES truncate via `outputDimensionality`.
//
//     That width is NOT stable: this endpoint served Qwen3-Embedding-4B
//     (2560) and then Qwen3-Embedding-0.6B (1024) an hour later. The check
//     below is what turns such a swap into a loud failure instead of a
//     corrupted index — it is load-bearing, not defensive boilerplate.
//
//  2. Hard context ceiling (max_model_len 4096). An over-long input is a
//     400 that fails the whole ingest, not a silent truncation, so
//     `truncate_prompt_tokens` is always sent. Chunking should keep inputs
//     well under this; this is the backstop that turns a crash into a
//     slightly-clipped embedding.
//
// Plain `fetch` rather than the OpenAI SDK, matching GeminiEmbedder: one
// POST, no streaming, no auth dance, no pagination.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import {
  Embedder,
  type EmbedderCallTimings,
  type EmbeddingVector,
} from './ports/embedder.port';

// Bumped whenever the embedding strategy/model changes. 'q1' rather than the
// Gemini adapter's 'g1' because the two vector spaces are NOT comparable —
// mixing them in one index silently degrades retrieval. D5's contract is
// that a version bump is a background re-embed (scripts/reembed-chunks.ts),
// never a schema rebuild.
const EMBEDDING_VERSION = 'q1';

interface VllmEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  error?: { message?: string };
}

@Injectable()
export class QwenEmbedder extends Embedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly maxInputTokens: number;
  /** D9: same Cloudflare Access service token as QwenLlmProvider — this box and the chat box are the same tunnel. */
  private readonly cfAccessClientId?: string;
  private readonly cfAccessClientSecret?: string;
  /** Bearer token for embeddingBaseUrl hosts that aren't behind Cloudflare Access (e.g. a plain OpenAI-compatible provider). */
  private readonly apiKey?: string;
  /** P0.3: warm-up flag to avoid redundant calls. */
  private warmedUp = false;

  constructor(config: AppConfigService) {
    super();
    this.baseUrl = config.embeddingBaseUrl.replace(/\/+$/, '');
    this.model = config.embeddingModel;
    this.dimensions = config.embeddingDimensions;
    this.maxInputTokens = config.embeddingMaxInputTokens;
    this.cfAccessClientId = config.cfAccessClientId;
    this.cfAccessClientSecret = config.cfAccessClientSecret;
    this.apiKey = config.embeddingApiKey;
  }

  /**
   * P0.3: warm up the connection pool by making a single embedding call at
   * startup. This primes the HTTP connection pool so the first real request
   * doesn't pay DNS/TCP/TLS handshake costs. Safe to call multiple times —
   * only the first call does work.
   */
  async warmUp(): Promise<void> {
    if (this.warmedUp) return;
    try {
      await this.embed('warm up');
      this.warmedUp = true;
    } catch {
      // Non-fatal: the pool will warm on first real request. Log and continue.
    }
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const [vector] = await this.embedBatch([text]);
    if (!vector) {
      throw new Error('vLLM embeddings API returned no embedding data');
    }
    return vector;
  }

  /**
   * Batch form. The endpoint accepts an array `input` and embeds it in one
   * forward pass — 32 inputs measured at ~1.9s against 32 sequential calls
   * at ~13s — which is what makes a full-corpus re-embed practical. `embed()`
   * above is the single-item case of this, so there is one request shape to
   * maintain, not two.
   */
  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];

    // P0.3: this is the single most expensive step on the retrieval path and
    // the reason the retrieval p95 bar fails, so the call is timed at the two
    // boundaries `fetch` exposes — headers (round trip + host compute) and
    // body (transfer + parse of ~22KB per vector). Date.now() rather than the
    // Clock port: this is an infrastructure adapter with no injected DI beyond
    // config, and a fake clock here would measure nothing useful.
    const requestStartMs = Date.now();

    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // D9: same Cloudflare Access service token model as
        // OpenAiCompatibleLlmProvider — omitted headers when unset (dev/CI
        // on an open LAN), required in production by env.schema.ts's
        // refine().
        ...(this.cfAccessClientId && this.cfAccessClientSecret
          ? {
              'CF-Access-Client-Id': this.cfAccessClientId,
              'CF-Access-Client-Secret': this.cfAccessClientSecret,
            }
          : {}),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        // See constraint 2 above — without this an over-long chunk is a 400
        // that kills the whole batch rather than a clipped vector.
        truncate_prompt_tokens: this.maxInputTokens,
      }),
    });

    const headersAtMs = Date.now();

    if (!response.ok) {
      // D9: a 401/403 here is the Cloudflare Access edge rejecting the
      // service token, not the vLLM box rejecting the embedding request —
      // named explicitly so a bad/expired CF_ACCESS_CLIENT_SECRET shows up
      // as an auth problem in ingest logs/alerts rather than an
      // undifferentiated "vLLM returned an error". The Embedder port has no
      // AgentError/rescue-policy pipeline of its own (ingest failures aren't
      // conversation-turn escalations), so this stays a plain Error with an
      // unambiguous message rather than a new error class.
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `vLLM embeddings API rejected the request as unauthenticated (HTTP ${response.status}) — check CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET (if this host sits behind Cloudflare Access) or EMBEDDING_API_KEY (if it expects a bearer token) for ${this.baseUrl}`,
        );
      }
      throw new Error(
        `vLLM embeddings API returned HTTP ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as VllmEmbeddingResponse;
    const bodyAtMs = Date.now();
    const timings: EmbedderCallTimings = {
      httpTtfbMs: headersAtMs - requestStartMs,
      httpBodyMs: bodyAtMs - headersAtMs,
      totalMs: bodyAtMs - requestStartMs,
    };
    const data = body.data;
    if (!data || data.length !== texts.length) {
      throw new Error(
        `vLLM embeddings API returned ${data?.length ?? 0} embeddings, expected ${texts.length}`,
      );
    }

    // The endpoint is documented to echo `index`, but ordering is not
    // guaranteed by the OpenAI contract, so sort rather than trust arrival
    // order — a silently mis-paired chunk/vector is unrecoverable later.
    const ordered = [...data].sort(
      (left, right) => (left.index ?? 0) - (right.index ?? 0),
    );

    return ordered.map((entry) => {
      const values = entry.embedding;
      if (!values || values.length === 0) {
        throw new Error('vLLM embeddings API returned no embedding data');
      }

      // A dimension mismatch would otherwise surface as an opaque Postgres
      // "expected N dimensions" error three layers down, inside the ingest
      // worker, long after the cause. Since this model cannot truncate, a
      // mismatch means EMBEDDING_DIMENSIONS disagrees with the served model
      // — a config error worth naming precisely.
      if (values.length !== this.dimensions) {
        throw new Error(
          `vLLM embeddings API returned ${values.length} dimensions, expected ${this.dimensions} — ` +
            `EMBEDDING_DIMENSIONS must match the served model's native width (this model cannot truncate)`,
        );
      }

      // Every vector in a batch shares the one HTTP call's timings — they
      // describe the call, not the individual embedding. Retrieval only ever
      // asks for one at a time, which is the case that matters here.
      return {
        values,
        embeddingModel: this.model,
        embeddingVersion: EMBEDDING_VERSION,
        timings,
      };
    });
  }
}
