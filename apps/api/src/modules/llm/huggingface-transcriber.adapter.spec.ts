import { TranscriptionFailed } from '@repo/errors';
import type { AppConfigService } from '../core';
import { HuggingFaceTranscriber } from './huggingface-transcriber.adapter';

function makeConfig(): AppConfigService {
  return {
    huggingfaceApiKey: 'hf_test_key',
    huggingfaceAsrModel: 'openai/whisper-large-v3',
    llmRequestTimeoutMs: 1000,
  } as unknown as AppConfigService;
}

const audio = Buffer.from([1, 2, 3]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('HuggingFaceTranscriber', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('posts raw audio to the hf-inference router route for the configured model', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: ' hello there ' }));

    const result = await new HuggingFaceTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello there', confidence: 0.8 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer hf_test_key',
      'Content-Type': 'audio/wav',
    });
  });

  it('strips mime parameters from Content-Type (WhatsApp sends audio/ogg; codecs=opus)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'hi' }));

    await new HuggingFaceTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'audio/ogg; codecs=opus',
    });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const init = calls[0][1];
    expect(init.headers).toMatchObject({ 'Content-Type': 'audio/ogg' });
  });

  it('names an exhausted-credits 402 as a billing problem, not a generic provider error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'You have depleted your monthly included credits.' },
        402,
      ),
    );

    const attempt = new HuggingFaceTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'audio/wav',
    });

    await expect(attempt).rejects.toBeInstanceOf(TranscriptionFailed);
    await expect(attempt).rejects.toThrow(/credits.*exhausted|402/i);
    await expect(attempt).rejects.toThrow(/ASR_PROVIDER/);
  });

  it('never echoes the API key in a failure message', async () => {
    fetchMock.mockResolvedValue(
      new Response('bad token hf_test_key', { status: 401 }),
    );

    const attempt = new HuggingFaceTranscriber(makeConfig()).transcribe({
      audio,
      mimeType: 'audio/wav',
    });

    await expect(attempt).rejects.toBeInstanceOf(TranscriptionFailed);
    await expect(attempt).rejects.not.toThrow(/hf_test_key/);
  });

  it('wraps a network failure as TranscriptionFailed', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      new HuggingFaceTranscriber(makeConfig()).transcribe({
        audio,
        mimeType: 'audio/wav',
      }),
    ).rejects.toBeInstanceOf(TranscriptionFailed);
  });

  it('treats an empty transcript as a failure, never a silent empty result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: '   ' }));

    await expect(
      new HuggingFaceTranscriber(makeConfig()).transcribe({
        audio,
        mimeType: 'audio/wav',
      }),
    ).rejects.toBeInstanceOf(TranscriptionFailed);
  });
});
