// Channel (MetaGraphModule, Gulf T1 / D8): Meta's Graph API error envelope,
// shared by every caller of MetaGraphClient — WhatsApp Cloud API sends and
// the Messenger/Instagram social channels alike.

/**
 * Thrown for any non-2xx Graph response. `code`/`subcode` are Meta's own —
 * 190 (with subcodes 458/463/467) is the family that means "this token is
 * dead, no retry will fix it", which is precisely the distinction
 * MetaTokenService needs to decide between "try again later" and "degrade
 * this channel to reconnect_required", and which the WhatsApp send path
 * needs for the same reason.
 *
 * The message never carries a bearer/access token: the client redacts any
 * token it sent before constructing one of these.
 */
export class MetaGraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    public readonly subcode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'MetaGraphError';
  }

  /** True when Meta is telling us the token itself is invalid/expired — the only class of failure a retry cannot fix. */
  get isTokenInvalid(): boolean {
    // 190 = OAuthException "access token" family. 102 = session expired.
    // 10/200-299 are permission errors, which a re-consent also fixes.
    if (this.code === 190 || this.code === 102) return true;
    if (this.code === 10) return true;
    if (this.code !== null && this.code >= 200 && this.code <= 299) return true;
    return false;
  }

  /**
   * Gulf T5 (D5): narrower than {@link isTokenInvalid}. True only when the
   * access token itself is dead: HTTP 401, code 190 (expired/revoked, incl.
   * subcodes 458/460/463/467) or 102 (session expired). This is the WhatsApp
   * send path's signal to degrade a number to `reconnect_required`.
   *
   * Permission errors (10, 200-299) are deliberately excluded here: on the
   * WhatsApp Cloud API they also come back for a WABA or number in a state
   * the tenant must fix in WhatsApp Manager, which a reconnect banner would
   * misdescribe. The daily reconcile's `health_status` read reports those.
   */
  get isAccessTokenRevoked(): boolean {
    return this.status === 401 || this.code === 190 || this.code === 102;
  }

  /**
   * Gulf T8 (D11): Meta throttled the call and did NOT perform it, so the
   * same request may be retried later. HTTP 429, or Graph's throttling
   * codes: 4 (app), 17 (user), 32 (page), 613 (custom rate limit) and the
   * 80000-80099 business-use-case family (80002 Instagram, 80006 Messenger).
   */
  get isRateLimited(): boolean {
    if (this.status === 429) return true;
    if (this.code === null) return false;
    if ([4, 17, 32, 613].includes(this.code)) return true;
    return this.code >= 80000 && this.code <= 80099;
  }

  /**
   * A copy of this error whose message names the operation that failed
   * (`"<operation> failed with HTTP <status>: <meta message>"`), keeping
   * status/code/subcode so `isTokenInvalid` still works. Returns a new
   * instance rather than mutating this one.
   */
  withOperation(operation: string): MetaGraphError {
    return new MetaGraphError(
      this.status,
      this.code,
      this.subcode,
      `${operation} failed with HTTP ${this.status}: ${this.message}`,
    );
  }
}
