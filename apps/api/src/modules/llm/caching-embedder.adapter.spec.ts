import type { Clock } from '../core/clock/clock';
import type { AppLoggerService } from '../core';
import {
  CachingEmbedder,
  CACHE_TTL_MS,
  MAX_CACHEABLE_TEXT_LENGTH,
  MAX_CACHE_ENTRIES,
} from './caching-embedder.adapter';
import type { EmbeddingVector } from './ports/embedder.port';

function vector(values: number[] = [0.1, 0.2]): EmbeddingVector {
  return {
    values,
    embeddingModel: 'qwen3-embedding-0.6b',
    embeddingVersion: 'qwen3-0.6b-v1',
    timings: { httpTtfbMs: 3400, httpBodyMs: 20, totalMs: 3420 },
  };
}

function harness(): {
  cache: CachingEmbedder;
  inner: jest.Mock;
  setNow: (ms: number) => void;
} {
  const inner = jest.fn(() => Promise.resolve(vector()));
  let nowMs = 1_000;
  const clock = { nowMs: () => nowMs } as unknown as Clock;
  const logger = { debug: jest.fn() } as unknown as AppLoggerService;
  return {
    cache: new CachingEmbedder({ embed: inner }, clock, logger),
    inner,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

describe('CachingEmbedder', () => {
  it('makes the remote call once for a repeated query', async () => {
    const { cache, inner } = harness();

    const first = await cache.embed('كم التوصيل للرياض؟');
    const second = await cache.embed('كم التوصيل للرياض؟');

    expect(inner).toHaveBeenCalledTimes(1);
    expect(second.values).toEqual(first.values);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('does not report HTTP timings on a hit — no round trip was paid for', async () => {
    const { cache } = harness();

    await cache.embed('فيه ضمان؟');
    const hit = await cache.embed('فيه ضمان؟');

    expect(hit.timings).toBeUndefined();
  });

  it('folds whitespace and case, which is the same question to a customer', async () => {
    const { cache, inner } = harness();

    await cache.embed('How much is delivery?');
    await cache.embed('  how much is  delivery?  ');

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('never caches a KB chunk — ingest keeps hitting the host', async () => {
    const { cache, inner } = harness();
    const chunk = 'x'.repeat(MAX_CACHEABLE_TEXT_LENGTH + 1);

    await cache.embed(chunk);
    await cache.embed(chunk);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(cache.stats().size).toBe(0);
  });

  it('re-embeds once the entry has expired', async () => {
    const { cache, inner, setNow } = harness();

    await cache.embed('بكم هذا؟');
    setNow(1_000 + CACHE_TTL_MS + 1);
    await cache.embed('بكم هذا؟');

    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('evicts the coldest entry at the size cap and keeps the hot one', async () => {
    const { cache, inner } = harness();
    await cache.embed('hot question');

    for (let i = 0; i < MAX_CACHE_ENTRIES; i += 1) {
      // Each hit on 'hot question' re-inserts it, so it must outlive the flood.
      await cache.embed('hot question');
      await cache.embed(`cold question ${i}`);
    }
    const callsBefore = inner.mock.calls.length;
    await cache.embed('hot question');

    expect(cache.stats().size).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    expect(inner).toHaveBeenCalledTimes(callsBefore);
  });
});
