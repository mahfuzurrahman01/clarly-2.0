// T3 amendment (Feature 17): THE escalation matrix. One file, imported by both
// the intake side (WebhookIngestService, which decides whether a message is
// worth fetching and answering) and the agent side (MediaUnderstandingService,
// which decides whether the bytes it actually got are usable). A second copy of
// this list on the webhook side would be the classic way for "we support webp"
// to become true in one place and false in the other.
//
// The matrix after Feature 17:
//   image/jpeg|png|webp|gif   -> answered, via A11's vision pipeline
//   audio/ogg|mpeg|mp4|m4a|aac|wav|webm|amr -> answered, via A12's ASR step
//   everything else (documents, video, stickers, contacts, locations)
//     -> still hard-escalates as UNSUPPORTED_MEDIA at intake, unchanged
//
// Deterministic code, never prompt text (D12). Nothing here asks a model
// whether it feels able to read a file.
import { MediaUnreadable } from '@repo/errors';
import type { TurnMediaKind } from './turn-media.dto';

export const UNDERSTOOD_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
];

export const UNDERSTOOD_AUDIO_MIME_TYPES: readonly string[] = [
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/amr',
];

/** Strips mime parameters — WhatsApp voice notes arrive as `audio/ogg; codecs=opus`. */
export function normalizeMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The intake-side half of the matrix: what the CHANNEL says this is.
 *
 * Returns null for anything outside the whitelist — the caller hard-escalates,
 * exactly as T3 did for every non-text message before Feature 17. A channel
 * that declares no mime type is classified by message type alone (Gulf T6).
 */
export function classifyDeclaredMedia(
  messageType: string,
  mimeType: string | null | undefined,
): TurnMediaKind | null {
  const mime = normalizeMimeType(mimeType);
  // Gulf T6 (D9): Messenger/Instagram declare a type and no mime at all. An
  // UNdeclared mime defers to the bytes, which assertUnderstandableMedia checks
  // (fetched content type + magic bytes) before any model sees them. A mime
  // that IS declared must still be on the whitelist.
  const undeclared = mime === '';
  if (
    messageType === 'image' &&
    (undeclared || UNDERSTOOD_IMAGE_MIME_TYPES.includes(mime))
  ) {
    return 'image';
  }
  if (
    messageType === 'voice' &&
    (undeclared || UNDERSTOOD_AUDIO_MIME_TYPES.includes(mime))
  ) {
    return 'voice';
  }
  return null;
}

/**
 * The agent-side half: what the BYTES say this is.
 *
 * A declared mime type is attacker-controlled — it is a field in a webhook
 * payload, not a property of the file — so it is checked against the payload's
 * own magic bytes before anything is sent to a model. A "photo" that is really
 * a zip, a truncated download, and an empty body all land here and become
 * MediaUnreadable, which is what makes Feature 17's "corrupt media escalates
 * cleanly, never crashes the loop" a code path.
 *
 * Returns null when the signature matches nothing known.
 */
export function sniffMediaKind(bytes: Buffer): TurnMediaKind | null {
  if (bytes.length < 4) return null;
  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);
  const asciiAt = (offset: number, text: string): boolean =>
    bytes.subarray(offset, offset + text.length).toString('latin1') === text;

  // Images
  if (startsWith(0xff, 0xd8, 0xff)) return 'image'; // JPEG
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image'; // PNG
  if (asciiAt(0, 'GIF8')) return 'image'; // GIF87a/89a
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return 'image'; // WebP

  // Audio
  if (asciiAt(0, 'OggS')) return 'voice'; // Ogg/Opus — WhatsApp voice notes
  if (asciiAt(0, 'ID3') || startsWith(0xff, 0xfb) || startsWith(0xff, 0xf3))
    return 'voice'; // MP3
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WAVE')) return 'voice'; // WAV
  if (asciiAt(4, 'ftyp')) return 'voice'; // MP4/M4A container
  if (asciiAt(0, '#!AMR')) return 'voice'; // AMR
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return 'voice'; // WebM/Matroska

  return null;
}

/**
 * Gate every attachment passes before a single byte reaches a model.
 *
 * Throws `MediaUnreadable` (rescue policy: UNSUPPORTED_MEDIA, not retryable) on
 * an empty body, an oversized body, a non-whitelisted mime type, or a payload
 * whose signature contradicts what the channel declared.
 */
export function assertUnderstandableMedia(
  kind: TurnMediaKind,
  mimeType: string,
  bytes: Buffer,
  maxBytes: number,
): void {
  const mime = normalizeMimeType(mimeType);
  const allowed =
    kind === 'image'
      ? UNDERSTOOD_IMAGE_MIME_TYPES.includes(mime)
      : UNDERSTOOD_AUDIO_MIME_TYPES.includes(mime);
  if (!allowed) {
    throw new MediaUnreadable(
      `Mime type "${mime || 'unknown'}" is not an understandable ${kind}`,
    );
  }
  if (bytes.length === 0) {
    throw new MediaUnreadable(`Empty ${kind} payload`);
  }
  if (bytes.length > maxBytes) {
    throw new MediaUnreadable(
      `${kind} payload is ${bytes.length} bytes, over the ${maxBytes}-byte understanding limit`,
    );
  }
  const sniffed = sniffMediaKind(bytes);
  if (sniffed !== kind) {
    throw new MediaUnreadable(
      `${kind} payload declared as "${mime}" does not match its own content signature`,
    );
  }
}
