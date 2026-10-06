// Gulf T8 (D11): the dedicated comment-automation queue. Separate from the
// respond path on purpose: a viral post's comment flood must queue behind
// itself, never in front of customers waiting on a DM answer.
import { z } from 'zod';

export const COMMENT_AUTOMATION_QUEUE = 'comment-automation';
export const COMMENT_AUTOMATION_JOB = 'handle-comment';

/** Worker-wide concurrency. Per-tenant concurrency is enforced on top (CommentRateLimiter). */
export const COMMENT_WORKER_CONCURRENCY = 5;

export const commentAutomationJobSchema = z.object({
  tenantId: z.string().uuid(),
  commentEventId: z.string().uuid(),
});
export type CommentAutomationJobData = z.infer<
  typeof commentAutomationJobSchema
>;

/** One job per ledger row. BullMQ ignores an add whose jobId already exists, which makes a re-enqueue on replay safe. */
export function commentJobId(commentEventId: string): string {
  return `comment-${commentEventId}`;
}
