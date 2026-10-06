import { AgentError } from './agent-error';

/**
 * A11/A12 (Feature 17): the bytes behind an inbound attachment cannot be
 * understood at all — the declared mime type is outside the understanding
 * whitelist, the payload's magic bytes contradict the declared type
 * (corrupt/truncated/renamed file), or it is too large to send to a
 * multimodal model.
 *
 * Owner: AgentModule's media stage, which is the only place that decides it.
 * Deliberately NOT retryable: the same bytes fail identically on the next
 * attempt. Its rescue policy escalates as `UNSUPPORTED_MEDIA`, which is what
 * keeps Feature 17's "malformed/corrupt media still escalates cleanly, never
 * silently drops" property a code path rather than a hope.
 */
export class MediaUnreadable extends AgentError {
  constructor(message = 'Inbound media could not be read') {
    super('MEDIA_UNREADABLE', message);
  }
}
