import { TranscriptionFailed } from '@repo/errors';
import type { AppConfigService } from '../core';
import {
  GeminiTranscriber,
  audioFormatFor,
  parseTranscriptionEnvelope,
} from './gemini-transcriber.adapter';

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

function makeConfig(): AppConfigService {
  return {
    geminiApiKey: 'key',
    asrBaseUrl: 'https://example.invalid/v1',
    asrModel: 'gemini-3.5-flash',
    llmRequestTimeoutMs: 1000,
  } as unknown as AppConfigService;
}

function reply(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('audioFormatFor', () => {
  it('ignores mime parameters (WhatsApp sends audio/ogg; codecs=opus)', () => {
    expect(audioFormatFor('audio/ogg; codecs=opus')).toBe('ogg');
  });

  it('returns null for a format no ASR vendor here accepts', () => {
    expect(audioFormatFor('application/pdf')).toBeNull();
  });
});

describe('parseTranscriptionEnvelope', () => {
  it('accepts a clean envelope and clamps its confidence', () => {
    expect(
      parseTranscriptionEnvelope(
        '{"transcript":"hello","audible":true,"confidence":1.4}',
      ),
    ).toEqual({ text: 'hello', confidence: 1 });
  });

  it('tolerates code fences', () => {
    expect(
      parseTranscriptionEnvelope(
        '```json\n{"transcript":"hi","audible":true,"confidence":0.7}\n```',
      ),
    ).toEqual({ text: 'hi', confidence: 0.7 });
  });

  it('rejects inaudible audio, empty transcripts, and unparseable replies', () => {
    expect(
      parseTranscriptionEnvelope(
        '{"transcript":"","audible":false,"confidence":0}',
      ),
    ).toBeNull();
    expect(
      parseTranscriptionEnvelope('{"transcript":"   ","audible":true}'),
    ).toBeNull();
    expect(parseTranscriptionEnvelope('sorry, I cannot do that')).toBeNull();
  });

  it('defaults a missing confidence rather than discarding words we did hear', () => {
    expect(
      parseTranscriptionEnvelope('{"transcript":"hello","audible":true}'),
    ).toEqual({ text: 'hello', confidence: 0.5 });
  });
});

describe('GeminiTranscriber', () => {
  beforeEach(() => mockCreate.mockReset());

  it('transcribes a voice note', async () => {
    mockCreate.mockResolvedValue(
      reply(
        '{"transcript":"where is my order","audible":true,"confidence":0.8}',
      ),
    );

    const result = await new GeminiTranscriber(makeConfig()).transcribe({
      audio: Buffer.from('audio'),
      mimeType: 'audio/ogg; codecs=opus',
    });

    expect(result).toEqual({ text: 'where is my order', confidence: 0.8 });
    const [params] = mockCreate.mock.calls[0] as [
      { messages: Array<{ content: Array<{ type: string }> }> },
    ];
    expect(params.messages[0].content.map((part) => part.type)).toEqual([
      'text',
      'input_audio',
    ]);
  });

  it('throws TranscriptionFailed for an unsupported audio format, without calling the provider', async () => {
    await expect(
      new GeminiTranscriber(makeConfig()).transcribe({
        audio: Buffer.from('x'),
        mimeType: 'application/zip',
      }),
    ).rejects.toBeInstanceOf(TranscriptionFailed);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('maps a provider failure onto TranscriptionFailed without echoing the response body', async () => {
    mockCreate.mockRejectedValue(new Error('401 key=sk-secret'));

    const promise = new GeminiTranscriber(makeConfig()).transcribe({
      audio: Buffer.from('x'),
      mimeType: 'audio/ogg',
    });

    await expect(promise).rejects.toBeInstanceOf(TranscriptionFailed);
  });

  it('throws rather than returning an empty transcript for inaudible audio', async () => {
    mockCreate.mockResolvedValue(
      reply('{"transcript":"","audible":false,"confidence":0}'),
    );

    await expect(
      new GeminiTranscriber(makeConfig()).transcribe({
        audio: Buffer.from('x'),
        mimeType: 'audio/ogg',
      }),
    ).rejects.toBeInstanceOf(TranscriptionFailed);
  });
});
