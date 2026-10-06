// A11/A12 (Feature 17): what a non-text attachment looks like once it reaches
// the agent. Bytes, not URLs or storage keys: the respond path has already
// fetched them from tenant-scoped storage, and AgentModule must not learn how
// storage addressing works to answer a photo.
import type { LlmImageAttachment } from '../../llm/ports/llm-provider.port';

export type TurnMediaKind = 'image' | 'voice';

export interface TurnMedia {
  kind: TurnMediaKind;
  /** The mime type the CHANNEL declared. Verified against the bytes themselves before use — see media-whitelist.ts. */
  mimeType: string;
  bytes: Buffer;
  /** The `messages` row this came from. Diagnostic only — never part of the prompt. */
  messageId?: string;
}

export interface MediaUnderstanding {
  /**
   * Text derived from the attachments — a voice note's transcript, an image's
   * description — already delimited as untrusted. Folded into the turn's
   * current message so retrieval, the forbidden-topic check, the prompt, and
   * the grounding check all see the same thing (D12: the guardrails cannot be
   * modality-specific).
   */
  derivedText: string;
  /** A11: the image bytes themselves, for a vision-capable provider. Empty when the turn carried no images or the binding cannot see them. */
  images: LlmImageAttachment[];
  /**
   * D10's modality term, 0..1 — the WORST understanding confidence across every
   * attachment on the turn. min(), not average: one unintelligible voice note
   * in a burst is enough to make the answer unsafe, and averaging would let a
   * clear photo hide it.
   */
  confidence: number;
  /**
   * Per-voice-note ASR transcripts, keyed by the `messages` row they came
   * from, for the caller to persist. Populated only for items with a
   * `messageId` — a `TurnMedia` built outside the webhook path (none exist
   * today, but the field is optional) simply has nothing to persist. Not
   * folded into `derivedText`: that string is prompt-shaped (delimited,
   * captioned, joined across attachments); this is the raw transcript text
   * a reader wants to see next to the audio player.
   */
  transcripts: { messageId: string; text: string }[];
}
