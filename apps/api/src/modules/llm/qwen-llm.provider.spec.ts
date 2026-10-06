import {
  AiHostAuthFailed,
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

// Imported after the mock so QwenLlmProvider picks up the faked SDK.
import { QwenLlmProvider, QwenVisionProvider } from './qwen-llm.provider';
import OpenAI from 'openai';

// The mocked SDK's APIError takes (status, message); the real one takes four
// arguments, so construct it through the faked shape rather than the real type.
const FakeApiError = OpenAI.APIError as unknown as new (
  status: number | undefined,
  message: string,
) => Error;

const BASE_URL = 'https://llm.arahim.dev/v1';
const MODEL = 'qwen3.6-35b-a3b';

function makeConfig(
  overrides: Partial<{
    cfAccessClientId: string | undefined;
    cfAccessClientSecret: string | undefined;
  }> = {},
): AppConfigService {
  return {
    llmBaseUrl: BASE_URL,
    llmModel: MODEL,
    llmRequestTimeoutMs: 10000,
    cfAccessClientId: undefined,
    cfAccessClientSecret: undefined,
    ...overrides,
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

describe('QwenLlmProvider — vLLM wiring', () => {
  it('points the OpenAI SDK at LLM_BASE_URL and sends no real credential (the host is unauthenticated)', () => {
    new QwenLlmProvider(makeConfig());

    const constructorMock = OpenAI as unknown as jest.Mock;
    const [options] = constructorMock.mock.calls.at(-1) as [
      { apiKey: string; baseURL: string },
    ];
    expect(options.baseURL).toBe(BASE_URL);
    expect(options.apiKey).toBe('not-required');
  });

  it('disables Qwen3 hybrid reasoning on every completion — thinking costs 5.4x the tokens for the same answer', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new QwenLlmProvider(makeConfig());

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    const [params] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(params.model).toBe(MODEL);
  });

  it('disables reasoning on tool-calling turns too', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new QwenLlmProvider(makeConfig());

    await provider.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
    });

    const [params] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

describe('QwenLlmProvider.complete()', () => {
  it('maps a normal response to LlmCompleteResult, using the server-reported usage', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new QwenLlmProvider(makeConfig());

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
    const provider = new QwenLlmProvider(makeConfig());

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.stopReason).toBe('max_tokens');
  });

  it('throws LLMEmptyResponse when content is empty and it is not a refusal', async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }),
    );
    const provider = new QwenLlmProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMEmptyResponse);
  });

  it('maps a timeout error to LLMTimeout — a cold vLLM box blows the default 10s deadline', async () => {
    mockCreate.mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    const provider = new QwenLlmProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMTimeout);
  });

  it('maps a 5xx APIError to LLMTimeout (D2: treated the same as a timeout for breaker purposes)', async () => {
    mockCreate.mockRejectedValue(new FakeApiError(503, 'Service unavailable'));
    const provider = new QwenLlmProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LLMTimeout);
  });

  it('does not map a 4xx APIError to LLMTimeout — rethrows as-is', async () => {
    mockCreate.mockRejectedValue(new FakeApiError(400, 'Bad request'));
    const provider = new QwenLlmProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.not.toBeInstanceOf(LLMTimeout);
  });

  // D9: the Cloudflare Access edge, not the model, rejects the request when
  // the service token is missing/wrong/expired — a distinct failure from
  // every other branch above, and it must not be silently swallowed into a
  // generic "provider error".
  it.each([401, 403])(
    'maps a %i APIError to AiHostAuthFailed, not LLMTimeout — a Cloudflare Access rejection, not a model error',
    async (status) => {
      mockCreate.mockRejectedValue(new FakeApiError(status, 'Forbidden'));
      const provider = new QwenLlmProvider(makeConfig());

      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow(AiHostAuthFailed);
    },
  );

  it('names the env vars to check in the AiHostAuthFailed message', async () => {
    mockCreate.mockRejectedValue(new FakeApiError(403, 'Forbidden'));
    const provider = new QwenLlmProvider(makeConfig());

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/CF_ACCESS_CLIENT_ID\/CF_ACCESS_CLIENT_SECRET/);
  });
});

describe('QwenLlmProvider — Cloudflare Access headers (D9)', () => {
  it('sends no CF-Access headers when the service token is unset (dev/CI open-LAN box)', () => {
    new QwenLlmProvider(makeConfig());

    const constructorMock = OpenAI as unknown as jest.Mock;
    const [options] = constructorMock.mock.calls.at(-1) as [
      { defaultHeaders?: Record<string, string> },
    ];
    expect(options.defaultHeaders).toBeUndefined();
  });

  it('sends both CF-Access headers when the service token is configured', () => {
    new QwenLlmProvider(
      makeConfig({
        cfAccessClientId: 'client-id-123',
        cfAccessClientSecret: 'client-secret-456',
      }),
    );

    const constructorMock = OpenAI as unknown as jest.Mock;
    const [options] = constructorMock.mock.calls.at(-1) as [
      { defaultHeaders?: Record<string, string> },
    ];
    expect(options.defaultHeaders).toEqual({
      'CF-Access-Client-Id': 'client-id-123',
      'CF-Access-Client-Secret': 'client-secret-456',
    });
  });

  it('sends neither header when only one of the pair is set (both-or-neither)', () => {
    new QwenLlmProvider(makeConfig({ cfAccessClientId: 'client-id-123' }));

    const constructorMock = OpenAI as unknown as jest.Mock;
    const [options] = constructorMock.mock.calls.at(-1) as [
      { defaultHeaders?: Record<string, string> },
    ];
    expect(options.defaultHeaders).toBeUndefined();
  });
});

describe('QwenLlmProvider.completeWithTools()', () => {
  it("parses vLLM's tool calls into the shape AgentRuntime consumes", async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'chatcmpl-tool-1',
                  type: 'function',
                  function: {
                    name: 'respond',
                    arguments:
                      '{"answer":"We open at 10am daily.","cited_chunk_ids":["c1"]}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = new QwenLlmProvider(makeConfig());

    const result = await provider.completeWithTools({
      messages: [{ role: 'user', content: 'when do you open?' }],
      tools: [{ name: 'respond', description: 'answers', inputSchema: {} }],
    });

    expect(result.toolCalls).toEqual([
      {
        id: 'chatcmpl-tool-1',
        name: 'respond',
        input: {
          answer: 'We open at 10am daily.',
          cited_chunk_ids: ['c1'],
        },
      },
    ]);
    // No vendor state to echo: unlike Gemini, vLLM emits no `extra_content`.
    expect(result.toolCalls[0]?.providerMetadata).toBeUndefined();
  });

  it('replays a prior tool call and its result back to the provider', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new QwenLlmProvider(makeConfig());

    await provider.completeWithTools({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'echo', input: { message: 'hi' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ],
      tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
    });

    const [params] = mockCreate.mock.calls[0] as [
      {
        messages: {
          role: string;
          tool_call_id?: string;
          tool_calls?: { id: string; function: { arguments: string } }[];
        }[];
      },
    ];
    expect(params.messages[1]?.tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      function: { arguments: '{"message":"hi"}' },
    });
    expect(params.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    });
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
    const provider = new QwenLlmProvider(makeConfig());

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
    const provider = new QwenLlmProvider(makeConfig());

    await expect(
      provider.completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'echo', description: 'echoes', inputSchema: {} }],
      }),
    ).resolves.toBeDefined();
  });
});

describe('QwenLlmProvider.countTokens()', () => {
  it('approximates a token count without calling the network', async () => {
    const provider = new QwenLlmProvider(makeConfig());

    const count = await provider.countTokens({
      messages: [{ role: 'user', content: 'a'.repeat(40) }],
    });

    expect(count).toBeGreaterThan(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// A11 on the self-hosted box: Qwen3.6-35B-A3B is multimodal (verified live
// 2026-09-29 — it named the Orbit V3 from the eval's product photo in 1.4s),
// so VISION_PROVIDER=qwen answers image turns on the same host and model as
// text turns instead of a second vendor's credential.
describe('QwenVisionProvider', () => {
  it('declares vision support; the text binding does not', () => {
    expect(new QwenVisionProvider(makeConfig()).supportsVision()).toBe(true);
    expect(new QwenLlmProvider(makeConfig()).supportsVision()).toBe(false);
  });

  it('sends image parts to the same host and model with reasoning off', async () => {
    mockCreate.mockResolvedValue(chatResponse());
    const provider = new QwenVisionProvider(makeConfig());

    await provider.completeWithTools({
      messages: [
        {
          role: 'user',
          content: 'what is this?',
          attachments: [{ mimeType: 'image/png', dataBase64: 'cG5n' }],
        },
      ],
      tools: [],
    } as never);

    const [params] = mockCreate.mock.calls[0] as [
      {
        model: string;
        chat_template_kwargs: unknown;
        messages: Array<{ content: unknown }>;
      },
    ];
    expect(params.model).toBe(MODEL);
    expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify(params.messages)).toContain('image_url');
  });
});
