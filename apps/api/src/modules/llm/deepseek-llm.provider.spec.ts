import type { AppConfigService } from '../core';

const mockCreate = jest.fn();

jest.mock('openai', () => {
  class FakeAPIError extends Error {}
  class FakeAPIConnectionTimeoutError extends FakeAPIError {}

  const FakeOpenAI = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })) as unknown as { new (...args: unknown[]): unknown } & {
    APIError: typeof FakeAPIError;
    APIConnectionTimeoutError: typeof FakeAPIConnectionTimeoutError;
  };
  FakeOpenAI.APIError = FakeAPIError;
  FakeOpenAI.APIConnectionTimeoutError = FakeAPIConnectionTimeoutError;

  return { __esModule: true, default: FakeOpenAI };
});

// Imported after the mock so the providers pick up the faked SDK.
import { DeepSeekLlmProvider } from './deepseek-llm.provider';
import { DeepSeekVisionProvider } from './deepseek-vision.provider';

const MODEL = 'deepseek-v4-flash';

function makeConfig(): AppConfigService {
  return {
    deepseekApiKey: 'test-key',
    deepseekBaseUrl: 'https://api.deepseek.com/v1',
    deepseekModel: MODEL,
    llmRequestTimeoutMs: 10000,
  } as unknown as AppConfigService;
}

function chatResponse() {
  return {
    choices: [
      {
        message: { content: 'price_question', tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(chatResponse());
});

describe.each([
  ['DeepSeekLlmProvider', DeepSeekLlmProvider],
  ['DeepSeekVisionProvider', DeepSeekVisionProvider],
])('%s — reasoning off', (_name, Provider) => {
  it('disables thinking on every completion — reasoning tokens count against max_tokens and empty small-budget calls', async () => {
    const provider = new Provider(makeConfig());

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    });

    const [params] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.model).toBe(MODEL);
    expect(params.max_tokens).toBe(8);
  });

  it('disables thinking on tool-calling turns too', async () => {
    const provider = new Provider(makeConfig());

    await provider.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
    });

    const [params] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.thinking).toEqual({ type: 'disabled' });
  });
});
