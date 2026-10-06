// Channel (MetaChannelModule, Feature 16): the named failures of the Meta
// social-channel path.
//
// Not AgentError subclasses: none of these are things the AGENT does. They
// are channel-plumbing failures with HTTP-level meanings (404 for an
// unrecognized page, a ticket for a dead token), so they stay local rather
// than joining T1's rescue registry, which is keyed to loop/send failures
// the agent can rescue. `ChannelWindowClosedError` — which the agent CAN
// hit — does live in @repo/errors, correctly.

/** No tenant has connected this Facebook page / Instagram account. Mirrors `UnknownWhatsappNumberError`; a webhook controller turns it into a 404. */
export class UnknownSocialChannelError extends Error {
  constructor(public readonly channelAccountId: string) {
    super(
      `No tenant has connected the Meta channel account "${channelAccountId}".`,
    );
    this.name = 'UnknownSocialChannelError';
  }
}

/**
 * Another tenant already has this Facebook page / Instagram account
 * connected.
 *
 * Security-critical, not a UX nicety: without this refusal, completing
 * Meta's OAuth for a page would silently repoint an existing tenant's
 * inbound webhooks (and their customers' messages) at whoever connected it
 * last. A controller turns this into a 409, deliberately without naming the
 * owning tenant.
 */
export class SocialChannelOwnedByAnotherTenantError extends Error {
  constructor(public readonly channelAccountId: string) {
    super(
      `Meta channel account "${channelAccountId}" is already connected to a different workspace.`,
    );
    this.name = 'SocialChannelOwnedByAnotherTenantError';
  }
}

/**
 * This channel's access token is dead and could not be refreshed, so it
 * cannot send. Feature 16's central degrade: thrown at the send path only.
 * Inbound ingest deliberately does NOT throw it — a channel that cannot
 * reply must still record what the customer said and escalate it to a
 * human, which is the difference between "degraded" and "dropped".
 */
export class SocialChannelReconnectRequiredError extends Error {
  constructor(
    public readonly channelAccountId: string,
    public readonly reason: string | null,
  ) {
    super(
      `Meta channel "${channelAccountId}" needs to be reconnected before it can send${
        reason ? `: ${reason}` : '.'
      }`,
    );
    this.name = 'SocialChannelReconnectRequiredError';
  }
}

/**
 * Gulf T4 (D4): the connect handshake is unknown, expired, or was started by
 * a different workspace/user. One error for all three on purpose: telling
 * them apart would let a caller probe for other workspaces' handshake ids.
 * The fix is the same in every case: run Facebook Login again.
 */
export class MetaConnectHandshakeExpiredError extends Error {
  constructor() {
    super(
      'This Facebook connection session has expired or does not belong to you. Log in with Facebook again.',
    );
    this.name = 'MetaConnectHandshakeExpiredError';
  }
}

/**
 * Gulf T4 (D4), the page-squat guard: the requested page is not in the list
 * Meta returned for the logged-in Facebook user, so that user has no role on
 * it and we hold no Meta-issued token for it. A controller turns this into
 * a 403.
 */
export class MetaPageNotManagedError extends Error {
  constructor(public readonly pageId: string) {
    super(
      `The Facebook account you logged in with does not manage page "${pageId}".`,
    );
    this.name = 'MetaPageNotManagedError';
  }
}

/** Gulf T4: Instagram was requested for a page that has no linked Instagram professional account. */
export class MetaInstagramNotLinkedError extends Error {
  constructor(public readonly pageId: string) {
    super(
      `Page "${pageId}" has no linked Instagram professional account. Link one in Meta Business Suite, then try again.`,
    );
    this.name = 'MetaInstagramNotLinkedError';
  }
}

/** Gulf T4: Meta refused the short-lived Facebook Login token (expired, revoked, or for another app). */
export class MetaLoginTokenRejectedError extends Error {
  constructor(detail: string) {
    super(`Meta rejected the Facebook Login token: ${detail}`);
    this.name = 'MetaLoginTokenRejectedError';
  }
}

/** A refresh attempt reached Meta and Meta said no. Carries the provider's own words — a tenant admin cannot act on "refresh failed". */
export class MetaTokenRefreshError extends Error {
  constructor(
    public readonly channelAccountId: string,
    detail: string,
  ) {
    super(
      `Meta refused to refresh the access token for "${channelAccountId}": ${detail}`,
    );
    this.name = 'MetaTokenRefreshError';
  }
}
