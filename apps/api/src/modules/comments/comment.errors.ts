// Gulf T8 (D11): named outcomes of the comment pipeline.

/**
 * The job must wait and run again later: the tenant is at its concurrency
 * limit, or the Instagram private-reply limiter (ours, or Meta's own
 * throttling) says not now. The processor turns this into a delayed job,
 * never a failure and never a drop.
 */
export class CommentDeferredError extends Error {
  constructor(
    public readonly delayMs: number,
    public readonly reason: string,
  ) {
    super(`Comment automation deferred ${delayMs}ms: ${reason}`);
    this.name = 'CommentDeferredError';
  }
}

/** A post rule named a channel account this workspace has not connected. The controller turns it into a 404. */
export class CommentChannelNotConnectedError extends Error {
  constructor(public readonly channelAccountId: string) {
    super(
      `Channel account "${channelAccountId}" is not a Facebook page or Instagram account connected to this workspace.`,
    );
    this.name = 'CommentChannelNotConnectedError';
  }
}
