// A12/D1 (Feature 17): the Transcriber binding, backed by Hugging Face
// Inference Providers' Whisper model (router.huggingface.co, hf-inference).
// This is NOT a free tier: every call draws on the account's monthly included
// credits, and once they are gone the router answers 402 until credits are
// bought. The 2026-09-30 eval cycle failed 15/15 voice turns exactly that way;
// ASR_PROVIDER=gemini is the swap point that does not depend on those credits.
//
// Same contract as GeminiTranscriber: sends raw audio bytes, gets back a
// strict JSON envelope with transcript + confidence. The confidence is
// estimated from the model's output quality signals (if available) or
// defaulted to 0.8 for successful transcriptions.
import { Injectable } from '@nestjs/common';
import { TranscriptionFailed } from '@repo/errors';
import { AppConfigService } from '../core';
import {
  Transcriber,
  UNSCORED_TRANSCRIPT_CONFIDENCE,
  type TranscriptionInput,
  type TranscriptionResult,
} from './ports/transcriber.port';

/** What a non-2xx status means to the operator. Never the response body: vendor error shapes can echo the credential that produced them (same rule as the Gemini adapter). */
function describeFailure(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'rejected HUGGINGFACE_API_KEY';
    case 402:
      return 'Inference Providers credits are exhausted (buy credits, or set ASR_PROVIDER=gemini)';
    case 429:
      return 'rate limited';
    default:
      return 'request failed';
  }
}

/** WhatsApp declares `audio/ogg; codecs=opus`; the inference route wants the bare media type. */
function bareMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim() || 'audio/ogg';
}

@Injectable()
export class HuggingFaceTranscriber extends Transcriber {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const model = this.config.huggingfaceAsrModel;
    const url = `https://router.huggingface.co/hf-inference/models/${model}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.huggingfaceApiKey}`,
          'Content-Type': bareMimeType(input.mimeType),
        },
        body: new Uint8Array(input.audio),
        signal: AbortSignal.timeout(this.config.llmRequestTimeoutMs),
      });
    } catch (error) {
      throw new TranscriptionFailed(
        `HuggingFace ASR provider call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (!response.ok) {
      throw new TranscriptionFailed(
        `HuggingFace ASR provider returned ${response.status}: ${describeFailure(response.status)}`,
      );
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new TranscriptionFailed(
        'HuggingFace ASR returned unparseable response',
      );
    }

    const parsed = this.parseResult(result);
    if (!parsed) {
      throw new TranscriptionFailed(
        'HuggingFace ASR returned no intelligible transcript for this audio',
      );
    }
    return parsed;
  }

  private parseResult(
    result: unknown,
  ): { text: string; confidence: number } | null {
    // Whisper HF API returns { "text": "..." } directly
    if (
      typeof result === 'object' &&
      result !== null &&
      'text' in result &&
      typeof result.text === 'string'
    ) {
      const text = (result as { text: string }).text.trim();
      if (!text) return null;
      return { text, confidence: UNSCORED_TRANSCRIPT_CONFIDENCE };
    }
    return null;
  }
}
