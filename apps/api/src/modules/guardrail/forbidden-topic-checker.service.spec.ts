import type { Embedder } from '../llm/ports/embedder.port';
import { ForbiddenTopicCheckerService } from './forbidden-topic-checker.service';

function makeEmbedder(vectorsByText: Record<string, number[]>): {
  embedder: Embedder;
  embed: jest.Mock;
} {
  const embed = jest.fn((text: string) =>
    Promise.resolve({
      values: vectorsByText[text] ?? [0, 0],
      embeddingModel: 'test',
      embeddingVersion: 'v1',
    }),
  );
  return { embedder: { embed }, embed };
}

describe('ForbiddenTopicCheckerService.check()', () => {
  it('returns not-forbidden when the tenant has no forbidden topics configured', async () => {
    const { embedder, embed } = makeEmbedder({});
    const service = new ForbiddenTopicCheckerService(embedder);

    const result = await service.check([1, 0], []);

    expect(result.isForbidden).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });

  it('flags a message whose embedding is close to a forbidden topic', async () => {
    const { embedder } = makeEmbedder({ refunds: [1, 0] });
    const service = new ForbiddenTopicCheckerService(embedder);

    const result = await service.check([1, 0], ['refunds']);

    expect(result.isForbidden).toBe(true);
    expect(result.matchedTopic).toBe('refunds');
    expect(result.similarity).toBeCloseTo(1);
  });

  it('does not flag a message whose embedding is far from every forbidden topic', async () => {
    const { embedder } = makeEmbedder({ refunds: [1, 0] });
    const service = new ForbiddenTopicCheckerService(embedder);

    const result = await service.check([0, 1], ['refunds']);

    expect(result.isForbidden).toBe(false);
  });

  it('picks the highest-similarity match across multiple forbidden topics', async () => {
    const { embedder } = makeEmbedder({
      refunds: [0.83, 0.01],
      pricing: [1, 0],
    });
    const service = new ForbiddenTopicCheckerService(embedder);

    const result = await service.check([1, 0], ['refunds', 'pricing']);

    expect(result.matchedTopic).toBe('pricing');
  });

  it('caches topic embeddings across calls — the embedder is only invoked once per distinct topic string', async () => {
    const { embedder, embed } = makeEmbedder({ refunds: [1, 0] });
    const service = new ForbiddenTopicCheckerService(embedder);

    await service.check([1, 0], ['refunds']);
    await service.check([0, 1], ['refunds']);
    await service.check([1, 0], ['refunds']);

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('never embeds the message itself — only forbidden-topic strings', async () => {
    const { embedder, embed } = makeEmbedder({ refunds: [1, 0] });
    const service = new ForbiddenTopicCheckerService(embedder);

    await service.check([1, 0], ['refunds']);

    expect(embed).toHaveBeenCalledWith('refunds');
    expect(embed).not.toHaveBeenCalledWith(expect.arrayContaining([1, 0]));
  });

  it('respects a custom similarity threshold', async () => {
    const { embedder } = makeEmbedder({ refunds: [0.9, Math.sqrt(1 - 0.81)] });
    const service = new ForbiddenTopicCheckerService(embedder);

    const lenient = await service.check([1, 0], ['refunds'], 0.5);
    const strict = await service.check([1, 0], ['refunds'], 0.99);

    expect(lenient.isForbidden).toBe(true);
    expect(strict.isForbidden).toBe(false);
  });
});
