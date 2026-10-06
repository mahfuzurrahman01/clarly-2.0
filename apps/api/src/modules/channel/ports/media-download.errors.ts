// Channel (ChannelModule, Gulf T6 / D9): the two ways an attachment download
// ends that a retry can never fix. Every other error from
// `ChannelAdapter.downloadMedia()` is treated as transient and retried by the
// media-download queue.
//
// Channel-neutral on purpose: the processor that catches these never learns
// which channel threw them.

/**
 * The attachment is bigger than `INBOUND_MEDIA_MAX_BYTES`. Thrown by a
 * download that enforces the cap while streaming, so the bytes past the cap
 * are never read. The processor records `too_large`, same as when the cap is
 * checked after a full download.
 */
export class MediaTooLargeError extends Error {
  constructor(
    /** Size when known (a Content-Length header, or the bytes read so far); null when not. */
    readonly sizeBytes: number | null,
    readonly limitBytes: number,
  ) {
    super(
      sizeBytes === null
        ? `Attachment is over the ${limitBytes}-byte limit.`
        : `Attachment is ${sizeBytes} bytes, over the ${limitBytes}-byte limit.`,
    );
    this.name = 'MediaTooLargeError';
  }
}

/**
 * The attachment must not be fetched at all (an off-allowlist url, a handle of
 * the wrong kind for this channel), or what came back is not something we
 * keep (a content type outside the whitelist). The message is stored on the
 * row as the failure reason, so it must be safe to show a tenant: it never
 * contains the url's query string.
 */
export class MediaRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MediaRejectedError';
  }
}
