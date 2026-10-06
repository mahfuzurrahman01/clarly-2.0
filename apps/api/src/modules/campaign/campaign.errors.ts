// F19 (D3): named outcomes of the campaign send path.
//
// The distinction that matters: a DEFERRAL is "not now, try again" and must
// never cost a BullMQ attempt or a recipient row; a PAUSE is "stop this
// campaign, leave every remaining recipient pending" and is a state the
// merchant resolves. Neither is ever a drop.

/**
 * The job must wait and run again later: a Meta tier or throughput limit, or
 * the per-number campaign semaphore. The processor turns this into a delayed
 * job via `job.moveToDelayed()`, which does NOT spend a retry attempt — the
 * exact pattern CommentAutomationProcessor already uses for the IG limiter.
 */
export class CampaignDeferredError extends Error {
  constructor(
    public readonly delayMs: number,
    public readonly reason: string,
  ) {
    super(`Campaign send deferred ${delayMs}ms: ${reason}`);
    this.name = 'CampaignDeferredError';
  }
}

/** Why a campaign stopped itself mid-send. Maps 1:1 onto the two `paused_*` statuses. */
export type CampaignPauseKind = 'spend_cap' | 'template' | 'eligibility';

/**
 * The campaign must stop with its remaining recipients INTACT. Answering
 * D3's question explicitly: a send that would exceed the cap queues (pauses
 * with recipients pending) — it does not partially send past the cap, and it
 * does not fail the campaign outright.
 */
export class CampaignPausedError extends Error {
  constructor(
    public readonly kind: CampaignPauseKind,
    public readonly detail: string,
  ) {
    super(`Campaign paused (${kind}): ${detail}`);
    this.name = 'CampaignPausedError';
  }
}

/**
 * The campaign is no longer in a state that sends (paused, canceled,
 * completed) — the worker simply stops. Not an error condition: it is what a
 * queued batch finds after an operator paused the campaign.
 */
export class CampaignNotSendingError extends Error {
  constructor(public readonly status: string) {
    super(`Campaign is "${status}", not sending`);
    this.name = 'CampaignNotSendingError';
  }
}
