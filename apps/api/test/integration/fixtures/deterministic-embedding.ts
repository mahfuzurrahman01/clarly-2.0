// Shared deterministic embedding fixture for the integration suites.
//
// Extracted because the same `deterministicVector()` had been copy-pasted
// into four suites with the vector width baked in as a literal default, and
// migration 0023 retyped `kb_chunks.embedding` from vector(1536) to
// vector(1024) for the Qwen embedder swap. Every one of those copies kept
// producing 1536 floats, so all four suites failed at the first kb_chunks
// INSERT with `expected 1024 dimensions, not 1536` — the ingest, retrieval,
// agent-runtime, telemetry and memory suites all went red at once, from one
// constant, in four places.
//
// One definition now, so the next width change is a one-line edit rather
// than a scavenger hunt.
import {
  Embedder,
  type EmbeddingVector,
} from '../../../src/modules/llm/ports/embedder.port';

/**
 * Must equal `kb_chunks.embedding`'s declared width. Not read from
 * `EMBEDDING_DIMENSIONS` at runtime on purpose: `envSchema` pins that
 * variable to exactly this value (and refuses to boot otherwise) precisely
 * because the column type is what really constrains it, so the tests assert
 * against the same fixed number the migration wrote rather than against a
 * variable that could be wrong in a developer's `.env`.
 */
export const TEST_EMBEDDING_DIMENSIONS = 1024;

/** Stable pseudo-random unit-ish vector derived from the text — same text always yields the same vector, so retrieval results are reproducible across runs without any network call. */
export function deterministicVector(
  text: string,
  dims: number = TEST_EMBEDDING_DIMENSIONS,
): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++)
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const values: number[] = [];
  for (let i = 0; i < dims; i++) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    values.push(((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5);
  }
  return values;
}

/**
 * Drop-in `Embedder` override for suites that need real pgvector
 * storage/search but no real embedding provider.
 *
 * Deliberately takes a couple of measurable milliseconds. A synchronous fake
 * returns in under the timer's resolution, `AgentRunTelemetry` drops every
 * span that stayed at 0 (correctly — "rerank was off" must not look like
 * "rerank took 0ms"), and the retrieval sub-spans then vanish from
 * `agent_runs.spans` for reasons that have nothing to do with the code under
 * test. A real embedder always costs something; this one does too, so the
 * telemetry plumbing is observable end to end.
 */
export class FakeEmbedder extends Embedder {
  async embed(text: string): Promise<EmbeddingVector> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return {
      values: deterministicVector(text),
      embeddingModel: 'fake',
      embeddingVersion: 'test',
    };
  }
}
