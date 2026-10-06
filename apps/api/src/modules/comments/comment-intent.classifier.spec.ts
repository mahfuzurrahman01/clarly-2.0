import type {
  LlmCompleteRequest,
  LlmProvider,
} from '../llm/ports/llm-provider.port';
import { CommentIntentClassifier } from './comment-intent.classifier';

describe('CommentIntentClassifier', () => {
  const usage = { inputTokens: 120, outputTokens: 1 };

  function classifierAnswering(content: string) {
    const complete = jest
      .fn<Promise<unknown>, [LlmCompleteRequest]>()
      .mockResolvedValue({ content, stopReason: 'end_turn', usage });
    return {
      complete,
      classifier: new CommentIntentClassifier({
        complete,
      } as unknown as LlmProvider),
    };
  }

  it('makes one short, deterministic call and parses the intent', async () => {
    const { complete, classifier } = classifierAnswering('purchase');

    await expect(classifier.classify('بكم هذا؟')).resolves.toEqual({
      intent: 'purchase',
      usage,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    expect(request.maxTokens).toBeLessThanOrEqual(8);
    expect(request.temperature).toBe(0);
    expect(request.messages[0].role).toBe('system');
    // The untrusted comment is fenced in the user turn, never in the system prompt.
    expect(request.messages[0].content).not.toContain('بكم هذا؟');
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: '<comment>\nبكم هذا؟\n</comment>',
    });
  });

  it('degrades an unparseable answer to other (do nothing), never to a reply', async () => {
    const { classifier } = classifierAnswering('Sure! Here is my analysis');
    await expect(classifier.classify('x')).resolves.toMatchObject({
      intent: 'other',
    });
  });

  it('truncates very long comments', async () => {
    const { complete, classifier } = classifierAnswering('other');
    await classifier.classify('a'.repeat(5000));
    expect(complete.mock.calls[0][0].messages[1].content.length).toBeLessThan(
      1100,
    );
  });

  it('lets a provider failure propagate so the job retries', async () => {
    const classifier = new CommentIntentClassifier({
      complete: jest.fn().mockRejectedValue(new Error('breaker open')),
    } as unknown as LlmProvider);
    await expect(classifier.classify('x')).rejects.toThrow('breaker open');
  });
});
