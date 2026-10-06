// A12/D1 (Feature 17): the Transcriber binding, backed by Gemini's multimodal
// audio input over the same OpenAI-compatible surface every other adapter here
// uses (`input_audio` content part).
//
// The adapter asks for a strict JSON envelope rather than a bare transcript for
// one reason: D10's composite confidence needs a modality term. "How well did
// you hear this" is information only the ASR step has, and throwing it away
// would leave a half-audible voice note indistinguishable from a clear one by
// the time the agent loop decides whether to escalate.
//
// Everything that is not a usable transcript — a provider error, an
// unparseable body, an inaudible recording, an empty string — becomes
// `TranscriptionFailed`. There is no return path from this adapter that means
// "nothing happened".
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { TranscriptionFailed } from '@repo/errors';
import { AppConfigService } from '../core';
import {
  Transcriber,
  type TranscriptionInput,
  type TranscriptionResult,
} from './ports/transcriber.port';

/** Wire `format` values for the `input_audio` part, keyed by the mime type the channel declared. WhatsApp voice notes are `audio/ogg; codecs=opus`. */
const AUDIO_FORMAT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/amr': 'amr',
};

const TRANSCRIPTION_INSTRUCTION = [
  'Transcribe the attached audio verbatim, in the language it was spoken in.',
  'Do not translate, summarise, answer, or add commentary.',
  'Reply with JSON only, no code fences, in exactly this shape:',
  '{"transcript": "<the words spoken>", "audible": <true|false>, "confidence": <0..1>}',
  'Set audible to false and transcript to "" if there is no intelligible speech.',
  'confidence is how clearly you heard the words, not how sure you are of their meaning.',
].join(' ');

export function audioFormatFor(mimeType: string): string | null {
  // WhatsApp sends `audio/ogg; codecs=opus` — the parameters are not part of
  // the lookup key.
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return AUDIO_FORMAT_BY_MIME[base] ?? null;
}

/** Exported for its own unit test: the model's JSON is untrusted output, and every way it can be wrong has to end at `null`, never at a fabricated transcript. */
export function parseTranscriptionEnvelope(
  raw: string,
): { text: string; confidence: number } | null {
  const withoutFences = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const envelope = parsed as {
    transcript?: unknown;
    audible?: unknown;
    confidence?: unknown;
  };
  if (envelope.audible === false) return null;
  if (typeof envelope.transcript !== 'string') return null;
  const text = envelope.transcript.trim();
  if (!text) return null;

  // A missing or out-of-range confidence is clamped rather than rejected: the
  // transcript itself is the valuable part, and an unusable confidence should
  // degrade the turn's composite score, not discard words we did hear.
  const rawConfidence =
    typeof envelope.confidence === 'number' &&
    Number.isFinite(envelope.confidence)
      ? envelope.confidence
      : 0.5;
  return { text, confidence: Math.min(1, Math.max(0, rawConfidence)) };
}

@Injectable()
export class GeminiTranscriber extends Transcriber {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfigService) {
    super();
    this.client = new OpenAI({
      apiKey: config.geminiApiKey,
      baseURL: config.asrBaseUrl,
    });
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const format = audioFormatFor(input.mimeType);
    if (!format) {
      throw new TranscriptionFailed(
        `No ASR format mapping for mime type "${input.mimeType}"`,
      );
    }

    let content: string;
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.asrModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: TRANSCRIPTION_INSTRUCTION },
                {
                  type: 'input_audio',
                  input_audio: {
                    data: input.audio.toString('base64'),
                    // The SDK types this as a narrow literal union; Gemini
                    // accepts the wider set above.
                    format: format as 'wav' | 'mp3',
                  },
                },
              ],
            },
          ],
        },
        { timeout: this.config.llmRequestTimeoutMs },
      );
      content = response.choices[0]?.message.content ?? '';
    } catch (error) {
      // Never echo the provider's response body: vendor error shapes can carry
      // the API key that produced them (same rule as the chat adapter).
      throw new TranscriptionFailed(
        `ASR provider call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const parsed = parseTranscriptionEnvelope(content);
    if (!parsed) {
      throw new TranscriptionFailed(
        'ASR returned no intelligible transcript for this audio',
      );
    }
    return { text: parsed.text, confidence: parsed.confidence };
  }
}
