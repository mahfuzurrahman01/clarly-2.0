// A12 (Feature 17): the ASR_PROVIDER=none binding. Throws rather than returns,
// for the same reason DisabledVisionProvider does — an unconfigured ASR must
// produce the pre-Feature-17 outcome (the voice note reaches a human as
// UNSUPPORTED_MEDIA), never an answer to words nobody heard.
import { Injectable } from '@nestjs/common';
import { TranscriptionFailed } from '@repo/errors';
import {
  Transcriber,
  type TranscriptionResult,
} from './ports/transcriber.port';

@Injectable()
export class DisabledTranscriber extends Transcriber {
  transcribe(): Promise<TranscriptionResult> {
    return Promise.reject(
      new TranscriptionFailed(
        'Voice transcription is not configured (ASR_PROVIDER=none).',
      ),
    );
  }
}
