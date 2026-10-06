import { TranscriptionFailed } from '@repo/errors';
import type { AppConfigService } from '../core';
import { OpenAiCompatibleTranscriber } from './openai-compatible-transcriber.adapter';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    asrBaseUrl: 'https://asr.example.test/v1/',
    asrModel: 'audarai/Audar-ASR-V1-Turbo',
    asrApiKey: '',
    llmRequestTimeoutMs: 1000,
    ...overrides,
  } as unknown as AppConfigService;
}

const audio = Buffer.from([1, 2, 3]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('OpenAiCompatibleTranscriber', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('posts multipart audio to /audio/transcriptions and returns the trimmed text', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: ' مرحبا ' }));

    const result = await new OpenAiCompatibleTranscriber(
      makeConfig(),
    ).transcribe({ audio, mimeType: 'audio/ogg; codecs=opus' });

    expect(result).toEqual({ text: 'مرحبا', confidence: 0.8 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://asr.example.test/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('audarai/Audar-ASR-V1-Turbo');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.ogg');
    expect(file.type).toBe('audio/ogg');
  });

  it('sends no Authorization header when ASR_API_KEY is empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'hi' }));

    await new OpenAiCompatibleTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'audio/wav',
    });

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('sends a bearer token when ASR_API_KEY is set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'hi' }));

    await new OpenAiCompatibleTranscriber(
      makeConfig({ asrApiKey: 'gsk_test' }),
    ).transcribe({ audio, mimeType: 'audio/wav' });

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer gsk_test' });
  });

  it('rejects a mime type with no format mapping before calling the provider', async () => {
    const attempt = new OpenAiCompatibleTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'application/pdf',
    });

    await expect(attempt).rejects.toBeInstanceOf(TranscriptionFailed);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a non-2xx status into TranscriptionFailed without echoing the body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'secret-bearing vendor body' }, 503),
    );

    const attempt = new OpenAiCompatibleTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'audio/wav',
    });

    await expect(attempt).rejects.toBeInstanceOf(TranscriptionFailed);
    await expect(attempt).rejects.toThrow(/503/);
    await expect(attempt).rejects.not.toThrow(/secret-bearing/);
  });

  it('turns a network error into TranscriptionFailed', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      new OpenAiCompatibleTranscriber(makeConfig()).transcribe({
        audio,
        mimeType: 'audio/wav',
      }),
    ).rejects.toThrow(/socket hang up/);
  });

  it.each([
    ['an empty transcript', { text: '   ' }],
    ['a body with no text field', { result: 'x' }],
  ])('treats %s as a failed transcription, never as ""', async (_, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(
      new OpenAiCompatibleTranscriber(makeConfig()).transcribe({
        audio,
        mimeType: 'audio/wav',
      }),
    ).rejects.toBeInstanceOf(TranscriptionFailed);
  });

  it('treats an unparseable body as a failed transcription', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(
      new OpenAiCompatibleTranscriber(makeConfig()).transcribe({
        audio,
        mimeType: 'audio/wav',
      }),
    ).rejects.toBeInstanceOf(TranscriptionFailed);
  });
});
