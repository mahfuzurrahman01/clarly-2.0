// Channel (MetaChannelModule, Gulf T6 / D9): downloads a Messenger/Instagram
// attachment from Meta's CDN.
//
// Different auth model from WhatsApp, which is why this is not
// `MetaGraphClient.getBinary()`: a WhatsApp media id is dereferenced with the
// number's bearer token in two hops, while a Messenger/Instagram webhook hands
// us a signed CDN url whose signature IS the credential. Sending a page token
// to a CDN host would leak it for nothing, so this request carries no
// Authorization header at all.
//
// Safety rules (D9), in the order they run:
//   1. the url must pass `parseAllowedSocialMediaUrl` (https, Meta CDN host
//      allowlist, no userinfo, default port). Anything else is refused
//      before a socket is opened, and the caller escalates to a human.
//   2. `redirect: 'error'`: the host checked in step 1 is the only host
//      ever contacted.
//   3. the response content type must be on ACCEPTED_MIME_TYPES.
//   4. the body is read against `INBOUND_MEDIA_MAX_BYTES` while streaming
//      (and refused up front on a larger Content-Length), so an oversized
//      or endless body is never buffered whole.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import {
  normalizeMimeType,
  UNDERSTOOD_AUDIO_MIME_TYPES,
  UNDERSTOOD_IMAGE_MIME_TYPES,
} from '../agent/media/media-whitelist';
import type { InboundMedia } from '../channel/ports/channel-adapter.port';
import {
  MediaRejectedError,
  MediaTooLargeError,
} from '../channel/ports/media-download.errors';
import { parseAllowedSocialMediaUrl } from './social-media-url.policy';

/**
 * What we keep from a social DM. The F17 image/audio lists (one source of
 * truth for "understandable"), plus the video and document types a human on
 * the ticket may need to open. Anything else is refused and escalated.
 */
export const ACCEPTED_SOCIAL_MIME_TYPES: readonly string[] = [
  ...UNDERSTOOD_IMAGE_MIME_TYPES,
  ...UNDERSTOOD_AUDIO_MIME_TYPES,
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

/** 4xx statuses worth a retry; every other 4xx means the url itself is dead or forbidden. */
const RETRYABLE_CLIENT_STATUSES: readonly number[] = [408, 429];

@Injectable()
export class SocialMediaFetcher {
  constructor(private readonly config: AppConfigService) {}

  /**
   * @throws MediaRejectedError off-allowlist url, refused redirect, dead url
   *   (4xx), or a content type we do not keep. Never retried.
   * @throws MediaTooLargeError over `INBOUND_MEDIA_MAX_BYTES`.
   * @throws Error anything transient (5xx, network, timeout). Retried.
   */
  async fetch(rawUrl: string): Promise<InboundMedia> {
    const url = parseAllowedSocialMediaUrl(rawUrl);
    if (!url) {
      throw new MediaRejectedError(
        `The attachment url (${describeHost(rawUrl)}) is not on Meta's attachment CDN allowlist, so it was not fetched.`,
      );
    }

    const response = await this.request(url);

    if (!response.ok) {
      await discard(response);
      const detail = `Attachment download from ${url.hostname} failed with HTTP ${response.status}.`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        !RETRYABLE_CLIENT_STATUSES.includes(response.status)
      ) {
        throw new MediaRejectedError(detail);
      }
      throw new Error(detail);
    }

    const mimeType = normalizeMimeType(response.headers.get('content-type'));
    if (!ACCEPTED_SOCIAL_MIME_TYPES.includes(mimeType)) {
      await discard(response);
      throw new MediaRejectedError(
        `Attachment content type "${mimeType || 'none'}" is not one we accept.`,
      );
    }

    const limit = this.config.inboundMediaMaxBytes;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await discard(response);
      throw new MediaTooLargeError(declared, limit);
    }

    return { content: await readCapped(response, limit), mimeType };
  }

  private async request(url: URL): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.bspRequestTimeoutMs),
      });
    } catch (error) {
      if (isRedirectRefusal(error)) {
        throw new MediaRejectedError(
          `The attachment host ${url.hostname} answered with a redirect, which is not followed.`,
        );
      }
      throw error;
    }
  }
}

/** Host only: the query string of a CDN url is its signature and must not land in a log line or on the message row. */
function describeHost(rawUrl: string): string {
  try {
    return `host ${new URL(rawUrl).hostname || 'none'}`;
  } catch {
    return 'not a url';
  }
}

/** undici rejects a refused redirect as `TypeError('fetch failed', { cause: Error('unexpected redirect') })`. */
function isRedirectRefusal(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof Error && /redirect/i.test(cause.message);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new MediaTooLargeError(null, limit);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
