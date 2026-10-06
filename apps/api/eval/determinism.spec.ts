import { resolveLlmConfig } from './determinism';

describe('resolveLlmConfig()', () => {
  it('uses explicit LLM_* vars', () => {
    expect(
      resolveLlmConfig({ LLM_PROVIDER: 'qwen', LLM_MODEL: 'qwen-x' }),
    ).toEqual({ llmProvider: 'qwen', llmModel: 'qwen-x' });
  });
  it('falls back to DEEPSEEK_MODEL then the schema default for deepseek', () => {
    expect(resolveLlmConfig({ DEEPSEEK_MODEL: 'ds-1' }).llmModel).toBe('ds-1');
    expect(resolveLlmConfig({})).toEqual({
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
    });
  });
  it('reports unknown for a non-deepseek provider without a model', () => {
    expect(resolveLlmConfig({ LLM_PROVIDER: 'gemini' }).llmModel).toBe(
      'unknown',
    );
  });
});
