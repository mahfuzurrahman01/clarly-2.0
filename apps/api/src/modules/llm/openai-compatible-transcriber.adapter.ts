// A12/D1 (Feature 17): the Transcriber binding for any server that speaks
// OpenAI's `POST /audio/transcriptions` (multipart, returns `{ "text": ... }`):
// a self-hosted Whisper / Audar-ASR behind vLLM, Groq, faster-whisper-server.
// ASR_BASE_URL picks the server, ASR_MODEL is passed through (some servers
// ignore it), and ASR_API_KEY is optional — keyless servers get no
// Authorization header at all.
//
// Like the Hugging Face binding, these servers return no confidence signal, so
// a usable transcript carries UNSCORED_TRANSCRIPT_CONFIDENCE. Everything that
// is not a usable transcript becomes `TranscriptionFailed`.
import { Injectable } from '@nestjs/common';
import { TranscriptionFailed } from '@repo/errors';
import { AppConfigService } from '../core';
import { audioFormatFor } from './gemini-transcriber.adapter';
import {
  Transcriber,
  UNSCORED_TRANSCRIPT_CONFIDENCE,
  type TranscriptionInput,
  type TranscriptionResult,
} from './ports/transcriber.port';

/** WhatsApp declares `audio/ogg; codecs=opus`; the multipart part wants the bare media type. */
function bareMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function transcriptionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
}

function parseText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('text' in body)) {
    return null;
  }
  const { text } = body;
  if (typeof text !== 'string') return null;
  return text.trim() || null;
}

@Injectable()
export class OpenAiCompatibleTranscriber extends Transcriber {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const format = audioFormatFor(input.mimeType);
    if (!format) {
      throw new TranscriptionFailed(
        `No ASR format mapping for mime type "${input.mimeType}"`,
      );
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.audio)], {
        type: bareMimeType(input.mimeType),
      }),
      `audio.${format}`,
    );
    form.append('model', this.config.asrModel);
    form.append('response_format', 'json');

    const apiKey = this.config.asrApiKey;
    let response: Response;
    try {
      response = await fetch(transcriptionsUrl(this.config.asrBaseUrl), {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(this.config.llmRequestTimeoutMs),
      });
    } catch (error) {
      throw new TranscriptionFailed(
        `ASR provider call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    // Never echo the response body: vendor error shapes can carry the
    // credential that produced them (same rule as the other adapters).
    if (!response.ok) {
      throw new TranscriptionFailed(`ASR provider returned ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TranscriptionFailed(
        'ASR provider returned unparseable response',
      );
    }

    const text = parseText(body);
    if (!text) {
      throw new TranscriptionFailed(
        'ASR provider returned no intelligible transcript for this audio',
      );
    }
    return { text, confidence: UNSCORED_TRANSCRIPT_CONFIDENCE };
  }
}
