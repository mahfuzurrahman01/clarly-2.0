import {
  LLMEmptyResponse,
  LLMMalformedToolCall,
  LLMTimeout,
} from '@repo/errors';
import type { AppConfigService } from '../core';

const mockCreate = jest.fn();

jest.mock('openai', () => {
  class FakeAPIError extends Error {
    status?: number;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.status = status;
    }
  }
  class FakeAPIConnectionTimeoutError extends FakeAPIError {
    constructor() {
      super(undefined, 'Request timed out');
    }
  }

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

// Imported after the mock so GeminiProvider picks up the faked SDK.
import { GeminiProvider } from './gemini.provider';
import OpenAI from 'openai';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

function makeConfig(): AppConfigService {
  return {
    geminiApiKey: 'test-key',
    llmBaseUrl: BASE_URL,
    llmModel: 'gemini-3.5-flash-lite',
    llmRequestTimeoutMs: 10000,
  } as unknown as AppConfigService;
}

function chatResponse(overrides: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        message: { content: 'hello', tool_calls: undefined },
        finish_reason: 'stop',
        ...((overrides.choice as Record<string, unknown>) ?? {}),
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('GeminiProvider.complete()', () => {
  it('maps a normal response to LlmCompleteResult', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new GeminiProvider(makeConfig());

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toEqual({
      content: 'hello',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('maps finish_reason "length" to stopReason "max_tokens"', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
      }),
    );
    const provider = new GeminiProvider(makeConfig());

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.stopReason).toBe('max_tokens');
  });

  it('maps finish_reason "content_filter" to stopReason "refusal" without throwing, even with empty content', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [
          { message: { content: '' }, finish_reason: 'content_filter' },
        ],
      }),
    );
    const provider = new GeminiProvider(makeConfig());

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.stopReason).toBe('refusal');
    expect(result.content).toBe('');
  });

  it('throws LLMEmptyResponse when content is empty and it is not a refusal', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }),
    );
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMEmptyResponse);
  });

  it('throws LLMEmptyResponse when there are no choices at all', async () => {
    mockCreate.mockResolvedValue({
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    });
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMEmptyResponse);
  });

  it('maps a timeout error to LLMTimeout', async () => {
    mockCreate.mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMTimeout);
  });

  it('maps a 5xx APIError to LLMTimeout (D2: treated the same as a timeout for breaker purposes)', async () => {
    mockCreate.mockRejectedValue(
      new OpenAI.APIError(503, {}, 'Service unavailable', new Headers()),
    );
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMTimeout);
  });

  it('does not map a 4xx APIError to LLMTimeout — rethrows as-is', async () => {
    mockCreate.mockRejectedValue(
      new OpenAI.APIError(400, {}, 'Bad request', new Headers()),
    );
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.not.toBeInstanceOf(LLMTimeout);
  });
});

describe('GeminiProvider.completeWithTools()', () => {
  it('parses well-formed tool calls', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"message":"hi"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = new GeminiProvider(makeConfig());

    const result = await provider.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
    });

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'echo', input: { message: 'hi' } },
    ]);
  });

  it("round-trips Gemini's extra_content back on the replayed tool call — replaying one without its thought_signature is rejected with a 400", async () => {
    const extraContent = { google: { thought_signature: 'sig-abc' } };
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"message":"hi"}' },
                  extra_content: extraContent,
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = new GeminiProvider(makeConfig());
    const tools = [{ name: 'echo', description: 'echoes', inputSchema: {} }];

    const first = await provider.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    expect(first.toolCalls[0]?.providerMetadata).toEqual({
      extra_content: extraContent,
    });

    mockCreate.mockResolvedValue(chatResponse());
    await provider.completeWithTools({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ],
      tools,
    });

    const [params] = mockCreate.mock.calls[1] as [
      { messages: { tool_calls?: { extra_content?: unknown }[] }[] },
    ];
    expect(params.messages[1]?.tool_calls?.[0]?.extra_content).toEqual(
      extraContent,
    );
  });

  it('throws LLMMalformedToolCall when tool arguments are not valid JSON', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'echo', arguments: '{not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
      }),
    ).rejects.toThrow(LLMMalformedToolCall);
  });

  it('does not throw LLMEmptyResponse when content is empty but tool calls are present', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'echo', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = new GeminiProvider(makeConfig());

    await expect(
      provider.completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
      }),
    ).resolves.toBeDefined();
  });
});

describe('GeminiProvider — SDK wiring', () => {
  it("points the OpenAI SDK at Gemini's OpenAI-compatible endpoint with GEMINI_API_KEY, so no request ever reaches a different vendor", () => {
    new GeminiProvider(makeConfig());

    const constructorMock = OpenAI as unknown as jest.Mock;
    const [options] = constructorMock.mock.calls.at(-1) as [
      { apiKey: string; baseURL: string },
    ];
    expect(options).toEqual({ apiKey: 'test-key', baseURL: BASE_URL });
  });

  it('sends no vendor-specific reasoning field — the request body stays plain OpenAI-compatible', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new GeminiProvider(makeConfig());

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    const [params] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params).not.toHaveProperty('thinking');
    expect(params.model).toBe('gemini-3.5-flash-lite');
  });
});

describe('GeminiProvider.countTokens()', () => {
  it('approximates a token count without calling the network', async () => {
    const provider = new GeminiProvider(makeConfig());

    const count = await provider.countTokens({
      messages: [{ role: 'user', content: 'a'.repeat(40) }],
    });

    expect(count).toBeGreaterThan(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
