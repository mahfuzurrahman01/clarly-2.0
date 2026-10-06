import type { AppConfigService } from '../core';

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

// Imported after the mock so the adapter picks up the faked SDK.
import { GeminiVisionProvider } from './gemini-vision.provider';

function makeConfig(): AppConfigService {
  return {
    geminiApiKey: 'key',
    visionBaseUrl: 'https://example.invalid/v1beta/openai',
    visionModel: 'gemini-3.5-flash',
    llmRequestTimeoutMs: 1000,
  } as unknown as AppConfigService;
}

describe('GeminiVisionProvider (A11)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });

  it('declares itself vision-capable — the text binding does not', () => {
    expect(new GeminiVisionProvider(makeConfig()).supportsVision()).toBe(true);
  });

  it('sends an attached image as a data-url image_url part, text first', async () => {
    await new GeminiVisionProvider(makeConfig()).complete({
      messages: [
        {
          role: 'user',
          content: 'what is this?',
          attachments: [{ mimeType: 'image/jpeg', dataBase64: 'QUJD' }],
        },
      ],
    });

    const [params] = mockCreate.mock.calls[0] as [
      {
        messages: Array<{
          role: string;
          content: Array<Record<string, unknown>>;
        }>;
      },
    ];
    expect(params.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,QUJD' },
      },
    ]);
  });

  it('leaves a plain user message as a plain string — no shape change for text turns', async () => {
    await new GeminiVisionProvider(makeConfig()).complete({
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [params] = mockCreate.mock.calls[0] as [
      { messages: Array<{ content: unknown }> },
    ];
    expect(params.messages[0].content).toBe('hello');
  });
});
