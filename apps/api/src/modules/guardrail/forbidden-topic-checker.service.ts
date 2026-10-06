// A6/D12: "Forbidden-topic check = embedding-similarity against tenant's
// list at intake (marginal cost ~0ms, reuses the retrieval query
// embedding)." The "~0ms" claim only holds if per-message cost is ONE
// embedding call (the message itself — supplied by the caller, reused from
// A1's retrieval embed, not re-embedded here) plus local vector math; this
// service embeds each tenant's forbidden-topic strings on first use and
// caches the resulting vectors in-process, so a message check never
// triggers more than the one embedding call the caller already needed for
// retrieval. T9's "<20ms added to p95" verify step is the actual budget
// this design is built against.
//
// Cache is process-local and keyed by exact topic string + embedding
// model/version — correct as long as EMBEDDING_MODEL doesn't change
// without a restart (Slice 1's OpenAiEmbedder binds it once at
// construction). A tenant editing their forbidden-topics list mid-process
// just adds new cache entries; stale entries for removed topics are
// harmless (never looked up again) rather than actively invalidated —
// acceptable for a process-local cache with no cross-instance consistency
// requirement. Swap for a persisted/shared cache (Redis, or a
// tenant_policy column) if the topic list grows large enough for repeated
// cold-starts to matter.
import { Injectable } from '@nestjs/common';
import { Embedder } from '../llm/ports/embedder.port';
import { cosineSimilarity } from './cosine-similarity';

export interface ForbiddenTopicMatch {
  isForbidden: boolean;
  matchedTopic?: string;
  similarity?: number;
}

/** D12: how close a message's embedding must be to a forbidden topic's to count as a match. Conservative default — false positives block a legitimate answer, false negatives are D12's whole reason to exist. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

@Injectable()
export class ForbiddenTopicCheckerService {
  private readonly topicEmbeddingCache = new Map<string, number[]>();

  constructor(private readonly embedder: Embedder) {}

  /** `messageEmbedding` must be the SAME embedding the caller already computed for retrieval (A1) — this method never embeds the message itself, only forbidden-topic strings (cached). */
  async check(
    messageEmbedding: readonly number[],
    forbiddenTopics: readonly string[],
    threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  ): Promise<ForbiddenTopicMatch> {
    if (forbiddenTopics.length === 0) {
      return { isForbidden: false };
    }

    let best: ForbiddenTopicMatch = { isForbidden: false };

    for (const topic of forbiddenTopics) {
      const topicEmbedding = await this.getTopicEmbedding(topic);
      const similarity = cosineSimilarity(messageEmbedding, topicEmbedding);

      if (
        similarity >= threshold &&
        (best.similarity === undefined || similarity > best.similarity)
      ) {
        best = { isForbidden: true, matchedTopic: topic, similarity };
      }
    }

    return best;
  }

  private async getTopicEmbedding(topic: string): Promise<number[]> {
    const cached = this.topicEmbeddingCache.get(topic);
    if (cached) return cached;

    const embedding = await this.embedder.embed(topic);
    this.topicEmbeddingCache.set(topic, embedding.values);
    return embedding.values;
  }
}
