import { AgentError } from './agent-error';

/**
 * A12 (Feature 17): the ASR step ahead of the normal text pipeline failed —
 * the provider errored, ASR is not configured at all, or the audio produced
 * no intelligible transcript.
 *
 * A12's own line: "transcription failures escalate the same way a
 * `KBNotIndexed` or `LLM_ERROR` would, not a silent drop." One retry (a
 * transcription call is a network call and transient failures are real),
 * then `UNSUPPORTED_MEDIA` — the customer sent something we could not read,
 * which is exactly what that reason means to the human who picks the ticket
 * up.
 */
export class TranscriptionFailed extends AgentError {
  constructor(message = 'Voice message could not be transcribed') {
    super('TRANSCRIPTION_FAILED', message);
  }
}
