import { MediaUnreadable, TranscriptionFailed } from '@repo/errors';
import type { AppConfigService, AppLoggerService } from '../../core';
import type { VisionLlmProvider } from '../../llm/ports/llm-provider.port';
import { MediaUnderstandingService } from './media-understanding.service';
import type { TurnMedia } from './turn-media.dto';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(8)]);

function makeService(opts: {
  visionContent?: string;
  visionError?: Error;
  transcribe?: jest.Mock;
  supportsVision?: boolean;
  maxBytes?: number;
}) {
  const complete = opts.visionError
    ? jest.fn().mockRejectedValue(opts.visionError)
    : jest.fn().mockResolvedValue({
        content: opts.visionContent ?? '{}',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
  const transcribe =
    opts.transcribe ??
    jest.fn().mockResolvedValue({ text: 'where is my order', confidence: 0.9 });
  const wait = jest.fn().mockResolvedValue(undefined);

  const service = new MediaUnderstandingService(
    {
      complete,
      supportsVision: () => opts.supportsVision ?? true,
    } as unknown as VisionLlmProvider,
    { transcribe },
    {
      mediaUnderstandingMaxBytes: opts.maxBytes ?? 8 * 1024 * 1024,
    } as unknown as AppConfigService,
    { wait },
    {
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as AppLoggerService,
  );

  return { service, complete, transcribe, wait };
}

const IMAGE: TurnMedia = {
  kind: 'image',
  mimeType: 'image/jpeg',
  bytes: JPEG,
  messageId: 'message-1',
};
const VOICE: TurnMedia = {
  kind: 'voice',
  mimeType: 'audio/ogg; codecs=opus',
  bytes: OGG,
  messageId: 'message-2',
};

describe('MediaUnderstandingService — images (A11)', () => {
  it('turns a product photo into searchable text and attaches the bytes for the loop', async () => {
    const { service, complete } = makeService({
      visionContent:
        '{"description":"A red Acme X200 blender, model sticker visible","legible":true,"confidence":0.9}',
    });

    const result = await service.understand([IMAGE]);

    expect(result.derivedText).toContain('Acme X200 blender');
    // Delimited exactly like L4/L6 content: data, never instructions.
    expect(result.derivedText).toContain('<untrusted_image_description>');
    expect(result.images).toEqual([
      { mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64') },
    ]);
    expect(result.confidence).toBe(0.9);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not attach bytes to a binding that cannot see them — but still describes the image', async () => {
    const { service } = makeService({
      supportsVision: false,
      visionContent:
        '{"description":"A blender","legible":true,"confidence":0.8}',
    });

    const result = await service.understand([IMAGE]);

    expect(result.images).toEqual([]);
    expect(result.derivedText).toContain('A blender');
  });

  it('escalates cleanly when the image is illegible', async () => {
    const { service } = makeService({
      visionContent: '{"description":"","legible":false,"confidence":0.1}',
    });

    await expect(service.understand([IMAGE])).rejects.toBeInstanceOf(
      MediaUnreadable,
    );
  });

  it('escalates cleanly when the vision provider fails or is unconfigured', async () => {
    const { service } = makeService({
      visionError: new Error('breaker open'),
    });

    await expect(service.understand([IMAGE])).rejects.toBeInstanceOf(
      MediaUnreadable,
    );
  });

  it('rejects corrupt bytes before spending a provider call at all', async () => {
    const { service, complete } = makeService({});

    await expect(
      service.understand([
        { kind: 'image', mimeType: 'image/jpeg', bytes: Buffer.from('%PDF-') },
      ]),
    ).rejects.toBeInstanceOf(MediaUnreadable);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('MediaUnderstandingService — voice (A12)', () => {
  it('transcribes a voice note into the text the normal pipeline runs on', async () => {
    const { service } = makeService({});

    const result = await service.understand([VOICE]);

    expect(result.derivedText).toContain('where is my order');
    expect(result.derivedText).toContain('<untrusted_voice_transcript>');
    // No answer generation of any kind happens here — only text.
    expect(result.images).toEqual([]);
    expect(result.confidence).toBe(0.9);
  });

  it('retries a transient ASR failure once, per RESCUE_POLICY', async () => {
    const transcribe = jest
      .fn()
      .mockRejectedValueOnce(new TranscriptionFailed('network blip'))
      .mockResolvedValue({ text: 'hello there', confidence: 0.7 });
    const { service, wait } = makeService({ transcribe });

    const result = await service.understand([VOICE]);

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalled();
    expect(result.derivedText).toContain('hello there');
  });

  it('gives up on a second failure with TranscriptionFailed — never a silent drop', async () => {
    const transcribe = jest
      .fn()
      .mockRejectedValue(new TranscriptionFailed('unintelligible'));
    const { service } = makeService({ transcribe });

    await expect(service.understand([VOICE])).rejects.toBeInstanceOf(
      TranscriptionFailed,
    );
    expect(transcribe).toHaveBeenCalledTimes(2);
  });
});

describe('MediaUnderstandingService — several attachments in one burst', () => {
  it('reports the WORST understanding confidence, not the average', async () => {
    const transcribe = jest
      .fn()
      .mockResolvedValue({ text: 'mumbled', confidence: 0.2 });
    const { service } = makeService({
      transcribe,
      visionContent:
        '{"description":"A clear photo","legible":true,"confidence":1}',
    });

    const result = await service.understand([IMAGE, VOICE]);

    expect(result.confidence).toBe(0.2);
    expect(result.derivedText).toContain('A clear photo');
    expect(result.derivedText).toContain('mumbled');
  });
});
