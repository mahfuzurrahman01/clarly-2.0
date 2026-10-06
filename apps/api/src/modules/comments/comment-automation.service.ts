// Gulf T8 (F23; D6, D11): what happens to one recorded comment.
//
//   received ──plan()──► planned ──execute()──► completed
//        └──────────────► skipped (with a reason)
//
// plan() runs the tiered filter once and stores its outcome (decision, intent
// and any reply texts) before anything is posted. A job that resumes after a
// deferral starts from `planned`, so neither the classifier nor the agent ever
// runs twice for one comment, and the agent_runs row (usage) is written once.
//
// Tiers (D11): rules prefilter -> cheap classify -> full agent, the last only
// for the intents the tenant answers. Caps are checked before any model spend:
// the tenant's entitlement and usage cap, a platform classifier cap, and the
// tenant's per-post and per-tenant hourly reply caps. Over a cap the comment
// is left alone (skipped, reason recorded); the one limit that DELAYS instead
// is the Instagram private-reply limiter, inside CommentActionExecutor.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { UsageService } from '../billing/usage.service';
import { CommentActionExecutor } from './comment-action.executor';
import { CommentIntentClassifier } from './comment-intent.classifier';
import {
  CommentLedgerService,
  type CommentEventRecord,
  type CommentPlanInput,
} from './comment-ledger.service';
import {
  canSendPrivateReply,
  decideForIntent,
  KEYWORD_TRIGGER_INTENT,
  prefilterComment,
} from './comment-policy';
import { CommentRateLimiter } from './comment-rate-limiter.service';
import { CommentReplyAgent } from './comment-reply-agent.service';
import {
  CommentRulesService,
  type EffectiveCommentRules,
} from './comment-rules.service';

/** Why a comment was left alone. Recorded verbatim in `comment_events.skip_reason`. */
export type CommentSkipReason =
  | 'automation_disabled'
  | 'post_not_enabled'
  | 'billing_blocked'
  | 'usage_cap'
  | 'no_text'
  | 'classify_cap'
  | 'intent_not_answered'
  | 'private_reply_window_closed'
  | 'tenant_hourly_cap'
  | 'post_hourly_cap'
  | 'private_reply_failed'
  | 'job_failed'
  /** The agent's own machinery failed (e.g. `agent_llm_error`). */
  | `agent_${string}`;

type PlanOutcome =
  | { kind: 'plan'; plan: CommentPlanInput }
  | { kind: 'skip'; reason: CommentSkipReason; intent: string | null };

@Injectable()
export class CommentAutomationService {
  constructor(
    private readonly ledger: CommentLedgerService,
    private readonly rules: CommentRulesService,
    private readonly usage: UsageService,
    private readonly limiter: CommentRateLimiter,
    private readonly classifier: CommentIntentClassifier,
    private readonly replyAgent: CommentReplyAgent,
    private readonly executor: CommentActionExecutor,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * @throws CommentDeferredError when an action must wait (the processor
   *   delays the job). The event stays `planned` and resumes from there.
   */
  async handle(
    tenantId: string,
    commentEventId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const event = await this.ledger.get(tenantId, commentEventId);
    if (!event || event.status === 'completed' || event.status === 'skipped') {
      return;
    }

    let planned: CommentEventRecord = event;
    if (event.status === 'received') {
      const outcome = await this.plan(event, now);
      if (outcome.kind === 'skip') {
        await this.ledger.skip(
          tenantId,
          event.id,
          outcome.reason,
          outcome.intent,
        );
        return;
      }
      await this.ledger.savePlan(tenantId, event.id, outcome.plan);
      planned = { ...event, ...outcome.plan, status: 'planned' };
    }

    const skipReason = await this.execute(planned, now);
    if (skipReason) {
      await this.ledger.skip(tenantId, event.id, skipReason);
      return;
    }
    await this.ledger.complete(tenantId, event.id);
  }

  private async plan(
    event: CommentEventRecord,
    now: Date,
  ): Promise<PlanOutcome> {
    const rules = await this.rules.resolveForPost(
      event.tenantId,
      event.channelAccountId,
      event.postId,
    );
    if (!rules.active) {
      return skip(rules.enabled ? 'post_not_enabled' : 'automation_disabled');
    }

    const entitlement = await this.usage.checkEntitlement(event.tenantId);
    if (!entitlement.allowed) return skip('billing_blocked');
    if (
      entitlement.hasEnforceablePlan &&
      (entitlement.overMessageLimit || entitlement.overSpendCap)
    ) {
      return skip('usage_cap');
    }

    const prefilter = prefilterComment(event.text, rules);
    switch (prefilter.kind) {
      case 'ignore':
        return skip(prefilter.reason);
      case 'spam':
        return rules.hideSpam
          ? { kind: 'plan', plan: hidePlan('spam_keyword') }
          : skip('intent_not_answered', 'spam_keyword');
      case 'trigger':
        return this.planReply(event, rules, KEYWORD_TRIGGER_INTENT, now);
      case 'classify': {
        const window = await this.limiter.classify(event.tenantId, now);
        if (!window.allowed) return skip('classify_cap');
        const { intent } = await this.classifier.classify(event.text);
        const decision = decideForIntent(intent, rules);
        if (decision === 'hide')
          return { kind: 'plan', plan: hidePlan(intent) };
        if (decision === 'reply') {
          return this.planReply(event, rules, intent, now);
        }
        return skip('intent_not_answered', intent);
      }
    }
  }

  private async planReply(
    event: CommentEventRecord,
    rules: EffectiveCommentRules,
    intent: string,
    now: Date,
  ): Promise<PlanOutcome> {
    // The public reply promises a DM; without a private reply there is
    // nothing to promise, so both go or neither does.
    if (!canSendPrivateReply(event.commentCreatedAt, now)) {
      return skip('private_reply_window_closed', intent);
    }
    const tenantWindow = await this.limiter.tenantReply(
      event.tenantId,
      rules.hourlyReplyCapPerTenant,
      now,
    );
    if (!tenantWindow.allowed) return skip('tenant_hourly_cap', intent);
    const postWindow = await this.limiter.postReply(
      event.tenantId,
      event.postId,
      rules.hourlyReplyCapPerPost,
      now,
    );
    if (!postWindow.allowed) return skip('post_hourly_cap', intent);

    const draft = await this.replyAgent.draft({
      tenantId: event.tenantId,
      channelAccountId: event.channelAccountId,
      text: event.text,
    });
    if (draft.kind === 'unavailable') return skip(draft.reason, intent);

    return {
      kind: 'plan',
      plan: {
        intent,
        decision: 'reply',
        privateReplyText: draft.text,
        publicReplyText: rules.publicReplyTemplate,
      },
    };
  }

  /** Runs the stored plan. Returns a skip reason when the plan could not be carried out, else null. */
  private async execute(
    event: CommentEventRecord,
    now: Date,
  ): Promise<CommentSkipReason | null> {
    if (event.decision === 'hide') {
      await this.executor.hide(event);
      return null;
    }
    if (event.decision !== 'reply') return null;

    if (!event.privateReplyText || !event.publicReplyText) {
      this.logger.warn(
        `comment ${event.commentId} was planned as a reply without reply texts; leaving it alone`,
        CommentAutomationService.name,
      );
      return 'private_reply_failed';
    }
    // A job deferred by the Instagram limiter can come back days later. Past
    // the window Meta would refuse; stop rather than burn the claim.
    if (
      event.threadState === null &&
      !canSendPrivateReply(event.commentCreatedAt, now)
    ) {
      return 'private_reply_window_closed';
    }

    const privateOutcome = await this.executor.privateReply(
      event,
      event.privateReplyText,
      now,
    );
    if (privateOutcome === 'failed') {
      // Never post "sent you a DM" for a DM that may not exist.
      return 'private_reply_failed';
    }
    await this.executor.publicReply(event, event.publicReplyText);
    return null;
  }
}

function skip(
  reason: CommentSkipReason,
  intent: string | null = null,
): PlanOutcome {
  return { kind: 'skip', reason, intent };
}

function hidePlan(intent: string): CommentPlanInput {
  return {
    intent,
    decision: 'hide',
    publicReplyText: null,
    privateReplyText: null,
  };
}
