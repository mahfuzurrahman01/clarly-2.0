// A12/D1 (Feature 17): the ASR port. Lives in LlmModule for the same reason
// the Embedder port does — it is a model-vendor capability, it is bound by an
// env-var swap point (ASR_PROVIDER), and every consumer injects this abstract
// class and never learns which vendor backs it.
//
// Enforced rule 2 still holds: this port has no knowledge of retrieval,
// conversations, or tenants. It converts bytes to text and reports how well it
// heard them; deciding what that means for a turn is A12's caller's job
// (AgentRuntime's media stage), not this port's.

/** Raw audio as it arrived from the channel — never a file path, never a URL. */
export interface TranscriptionInput {
  audio: Buffer;
  /** The mime type the CHANNEL declared. Already whitelist-checked by the caller. */
  mimeType: string;
}

export interface TranscriptionResult {
  /** Verbatim transcript. Never empty — an adapter that cannot produce one throws `TranscriptionFailed` instead of returning ''. */
  text: string;
  /**
   * D10 extension for non-text modalities: how confidently the audio was heard,
   * 0..1. This becomes the `modalityConfidence` term of the composite
   * confidence, so a mumbled or half-audible note cannot produce a confident
   * answer no matter how sure the model is about the words it guessed.
   */
  confidence: number;
}

/** Confidence for a usable transcript from an ASR that reports none (Whisper-style `{ text }` APIs). */
export const UNSCORED_TRANSCRIPT_CONFIDENCE = 0.8;

/** Abstract class so it doubles as its own NestJS DI token — same convention as LlmProvider/Embedder/ObjectStorage. */
export abstract class Transcriber {
  abstract transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
