// F19 (D3, D8): the dedicated campaign-send queue.
//
// Separate from the respond path on purpose, exactly as the comment queue
// is: a 40 000-recipient broadcast must queue behind itself, never in front
// of a customer waiting on an answer.
//
// Two job names on one queue, because they are the same pipeline and share
// its concurrency budget:
//   - `launch`     — delayed until `scheduled_at`; snapshots the segment and
//                    starts the first batch. One per campaign.
//   - `send-batch` — CAMPAIGN_BATCH_SIZE recipients, sent sequentially, and
//                    self-chaining: the batch that finishes enqueues the
//                    next. 50k recipients is 1 000 jobs, not 50 000, and
//                    chaining keeps exactly one batch of a campaign in
//                    flight without a second coordination mechanism.
import { z } from 'zod';

export const CAMPAIGN_SEND_QUEUE = 'campaign-send';
export const CAMPAIGN_LAUNCH_JOB = 'launch';
export const CAMPAIGN_BATCH_JOB = 'send-batch';

/** Worker-wide concurrency. Per-NUMBER concurrency (1) is enforced on top by CampaignRateLimiter. */
export const CAMPAIGN_WORKER_CONCURRENCY = 3;

export const campaignJobSchema = z.object({
  tenantId: z.string().uuid(),
  campaignId: z.string().uuid(),
  /** Monotonic per campaign; only used to keep chained job ids unique. */
  batch: z.number().int().nonnegative().default(0),
});
export type CampaignJobData = z.infer<typeof campaignJobSchema>;

/** BullMQ ignores an add whose jobId already exists, which makes a double schedule safe. */
export function campaignLaunchJobId(campaignId: string): string {
  return `campaign-launch-${campaignId}`;
}

export function campaignBatchJobId(campaignId: string, batch: number): string {
  return `campaign-batch-${campaignId}-${batch}`;
}
