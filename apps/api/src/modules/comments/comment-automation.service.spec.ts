import type { UsageService } from '../billing/usage.service';
import type { AppLoggerService } from '../core';
import type { CommentActionExecutor } from './comment-action.executor';
import { CommentAutomationService } from './comment-automation.service';
import type { CommentIntentClassifier } from './comment-intent.classifier';
import type {
  CommentEventRecord,
  CommentLedgerService,
} from './comment-ledger.service';
import type { CommentRateLimiter } from './comment-rate-limiter.service';
import type { CommentReplyAgent } from './comment-reply-agent.service';
import {
  DEFAULT_COMMENT_SETTINGS,
  type CommentRulesService,
  type EffectiveCommentRules,
} from './comment-rules.service';
import { CommentDeferredError } from './comment.errors';

const NOW = new Date('2026-09-19T10:00:00Z');

function event(
  overrides: Partial<CommentEventRecord> = {},
): CommentEventRecord {
  return {
    id: 'evt-1',
    tenantId: 't1',
    channel: 'instagram',
    channelAccountId: 'ig-1',
    commentId: 'igc-1',
    postId: 'media-1',
    parentId: null,
    authorId: 'IGSID-1',
    authorName: 'buyer',
    text: 'how much for the black one?',
    mediaProductType: 'REELS',
    commentCreatedAt: new Date(NOW.getTime() - 60_000),
    status: 'received',
    skipReason: null,
    intent: null,
    decision: null,
    publicReplyText: null,
    privateReplyText: null,
    privateReplyRecipientId: null,
    privateReplyMessageId: null,
    privateReplySentAt: null,
    threadState: null,
    conversationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const activeRules: EffectiveCommentRules = {
  ...DEFAULT_COMMENT_SETTINGS,
  enabled: true,
  keywordTriggers: ['price'],
  spamKeywords: ['crypto'],
  publicReplyTemplate: 'Sent you the details in DM',
  active: true,
};

describe('CommentAutomationService', () => {
  let stored: CommentEventRecord;
  let ledger: {
    get: jest.Mock;
    savePlan: jest.Mock;
    skip: jest.Mock;
    complete: jest.Mock;
  };
  let rules: { resolveForPost: jest.Mock };
  let usage: { checkEntitlement: jest.Mock };
  let limiter: {
    classify: jest.Mock;
    tenantReply: jest.Mock;
    postReply: jest.Mock;
  };
  let classifier: { classify: jest.Mock };
  let replyAgent: { draft: jest.Mock };
  let executor: {
    hide: jest.Mock;
    publicReply: jest.Mock;
    privateReply: jest.Mock;
  };
  let service: CommentAutomationService;

  beforeEach(() => {
    stored = event();
    ledger = {
      get: jest.fn(() => Promise.resolve(stored)),
      savePlan: jest.fn((_t: string, _id: string, plan: object) => {
        stored = { ...stored, ...plan, status: 'planned' };
        return Promise.resolve();
      }),
      skip: jest.fn((_t: string, _id: string, reason: string) => {
        stored = { ...stored, status: 'skipped', skipReason: reason };
        return Promise.resolve();
      }),
      complete: jest.fn(() => {
        stored = { ...stored, status: 'completed' };
        return Promise.resolve();
      }),
    };
    rules = { resolveForPost: jest.fn().mockResolvedValue(activeRules) };
    usage = {
      checkEntitlement: jest.fn().mockResolvedValue({
        allowed: true,
        hasEnforceablePlan: true,
        overMessageLimit: false,
        overSpendCap: false,
      }),
    };
    limiter = {
      classify: jest.fn().mockResolvedValue({ allowed: true }),
      tenantReply: jest.fn().mockResolvedValue({ allowed: true }),
      postReply: jest.fn().mockResolvedValue({ allowed: true }),
    };
    classifier = {
      classify: jest.fn().mockResolvedValue({
        intent: 'purchase',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    replyAgent = {
      draft: jest
        .fn()
        .mockResolvedValue({ kind: 'answer', text: 'It is 250 SAR.' }),
    };
    executor = {
      hide: jest.fn().mockResolvedValue('succeeded'),
      publicReply: jest.fn().mockResolvedValue('succeeded'),
      privateReply: jest.fn().mockResolvedValue('succeeded'),
    };
    service = new CommentAutomationService(
      ledger as unknown as CommentLedgerService,
      rules as unknown as CommentRulesService,
      usage as unknown as UsageService,
      limiter as unknown as CommentRateLimiter,
      classifier as unknown as CommentIntentClassifier,
      replyAgent as unknown as CommentReplyAgent,
      executor as unknown as CommentActionExecutor,
      { warn: jest.fn() } as unknown as AppLoggerService,
    );
  });

  it('purchase intent -> one private reply (agent answer), then one public reply (template)', async () => {
    await service.handle('t1', 'evt-1', NOW);

    expect(classifier.classify).toHaveBeenCalledWith(
      'how much for the black one?',
    );
    expect(replyAgent.draft).toHaveBeenCalledWith({
      tenantId: 't1',
      channelAccountId: 'ig-1',
      text: 'how much for the black one?',
    });
    expect(ledger.savePlan).toHaveBeenCalledWith('t1', 'evt-1', {
      intent: 'purchase',
      decision: 'reply',
      privateReplyText: 'It is 250 SAR.',
      publicReplyText: 'Sent you the details in DM',
    });
    expect(executor.privateReply).toHaveBeenCalledTimes(1);
    expect(executor.privateReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-1' }),
      'It is 250 SAR.',
      NOW,
    );
    expect(executor.publicReply).toHaveBeenCalledTimes(1);
    expect(executor.publicReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-1' }),
      'Sent you the details in DM',
    );
    expect(executor.privateReply.mock.invocationCallOrder[0]).toBeLessThan(
      executor.publicReply.mock.invocationCallOrder[0],
    );
    expect(stored.status).toBe('completed');
  });

  it('does nothing more for an already-completed comment (replayed job)', async () => {
    await service.handle('t1', 'evt-1', NOW);
    await service.handle('t1', 'evt-1', NOW);
    expect(replyAgent.draft).toHaveBeenCalledTimes(1);
    expect(executor.privateReply).toHaveBeenCalledTimes(1);
    expect(executor.publicReply).toHaveBeenCalledTimes(1);
  });

  it('hides spam, and never answers it', async () => {
    stored = event({ text: 'earn crypto fast, price in bio' });
    await service.handle('t1', 'evt-1', NOW);
    expect(executor.hide).toHaveBeenCalledTimes(1);
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(replyAgent.draft).not.toHaveBeenCalled();
    expect(executor.privateReply).not.toHaveBeenCalled();
    expect(executor.publicReply).not.toHaveBeenCalled();
  });

  it('hides a comment the classifier calls abuse', async () => {
    classifier.classify.mockResolvedValue({ intent: 'abuse', usage: {} });
    await service.handle('t1', 'evt-1', NOW);
    expect(executor.hide).toHaveBeenCalledTimes(1);
    expect(replyAgent.draft).not.toHaveBeenCalled();
  });

  it('answers a trigger keyword without spending a classifier call', async () => {
    stored = event({ text: 'PRICE??' });
    await service.handle('t1', 'evt-1', NOW);
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(ledger.savePlan).toHaveBeenCalledWith(
      't1',
      'evt-1',
      expect.objectContaining({ intent: 'keyword', decision: 'reply' }),
    );
  });

  it.each([
    ['other', 'intent_not_answered'],
    ['complaint', 'intent_not_answered'],
  ])('leaves a %s comment alone', async (intent, reason) => {
    classifier.classify.mockResolvedValue({ intent, usage: {} });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenCalledWith('t1', 'evt-1', reason, intent);
    expect(replyAgent.draft).not.toHaveBeenCalled();
  });

  it('does nothing while automation is off, or for a post that is not enabled', async () => {
    rules.resolveForPost.mockResolvedValue({
      ...activeRules,
      enabled: false,
      active: false,
    });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenCalledWith(
      't1',
      'evt-1',
      'automation_disabled',
      null,
    );

    stored = event();
    rules.resolveForPost.mockResolvedValue({ ...activeRules, active: false });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenLastCalledWith(
      't1',
      'evt-1',
      'post_not_enabled',
      null,
    );
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('spends nothing for a tenant over its usage cap or blocked by billing', async () => {
    usage.checkEntitlement.mockResolvedValue({
      allowed: true,
      hasEnforceablePlan: true,
      overMessageLimit: true,
      overSpendCap: false,
    });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenCalledWith('t1', 'evt-1', 'usage_cap', null);

    stored = event();
    usage.checkEntitlement.mockResolvedValue({ allowed: false });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenLastCalledWith(
      't1',
      'evt-1',
      'billing_blocked',
      null,
    );
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantReply', 'tenant_hourly_cap'],
    ['postReply', 'post_hourly_cap'],
  ] as const)(
    'respects the %s cap before running the agent',
    async (cap, reason) => {
      limiter[cap].mockResolvedValue({ allowed: false, retryAfterMs: 1 });
      await service.handle('t1', 'evt-1', NOW);
      expect(ledger.skip).toHaveBeenCalledWith(
        't1',
        'evt-1',
        reason,
        'purchase',
      );
      expect(replyAgent.draft).not.toHaveBeenCalled();
    },
  );

  it('skips the classifier past the platform classify cap', async () => {
    limiter.classify.mockResolvedValue({ allowed: false, retryAfterMs: 1 });
    await service.handle('t1', 'evt-1', NOW);
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(ledger.skip).toHaveBeenCalledWith(
      't1',
      'evt-1',
      'classify_cap',
      null,
    );
  });

  it('does not reply to a comment older than the private-reply window', async () => {
    stored = event({
      commentCreatedAt: new Date(NOW.getTime() - 8 * 24 * 3600 * 1000),
    });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenCalledWith(
      't1',
      'evt-1',
      'private_reply_window_closed',
      'purchase',
    );
    expect(replyAgent.draft).not.toHaveBeenCalled();
  });

  it('sends nothing when the agent could not produce an answer', async () => {
    replyAgent.draft.mockResolvedValue({
      kind: 'unavailable',
      reason: 'agent_llm_error',
    });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenCalledWith(
      't1',
      'evt-1',
      'agent_llm_error',
      'purchase',
    );
    expect(executor.privateReply).not.toHaveBeenCalled();
  });

  it('never posts the public "sent you a DM" when the private reply failed', async () => {
    executor.privateReply.mockResolvedValue('failed');
    await service.handle('t1', 'evt-1', NOW);
    expect(executor.publicReply).not.toHaveBeenCalled();
    expect(ledger.skip).toHaveBeenCalledWith(
      't1',
      'evt-1',
      'private_reply_failed',
    );
  });

  it('a deferred private reply resumes from the stored plan: no second classify or agent run', async () => {
    executor.privateReply.mockRejectedValueOnce(
      new CommentDeferredError(60_000, 'instagram private-reply limit'),
    );
    await expect(service.handle('t1', 'evt-1', NOW)).rejects.toBeInstanceOf(
      CommentDeferredError,
    );
    expect(stored.status).toBe('planned');
    expect(executor.publicReply).not.toHaveBeenCalled();

    await service.handle('t1', 'evt-1', new Date(NOW.getTime() + 60_000));
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(replyAgent.draft).toHaveBeenCalledTimes(1);
    expect(executor.privateReply).toHaveBeenCalledTimes(2);
    expect(executor.publicReply).toHaveBeenCalledTimes(1);
    expect(stored.status).toBe('completed');
  });

  it('a deferred job that comes back after the window closed stops instead of burning the claim', async () => {
    stored = event({
      status: 'planned',
      decision: 'reply',
      intent: 'purchase',
      privateReplyText: 'x',
      publicReplyText: 'y',
      commentCreatedAt: new Date(NOW.getTime() - 7 * 24 * 3600 * 1000),
    });
    await service.handle('t1', 'evt-1', NOW);
    expect(executor.privateReply).not.toHaveBeenCalled();
    expect(ledger.skip).toHaveBeenCalledWith(
      't1',
      'evt-1',
      'private_reply_window_closed',
    );
  });

  it('ignores a comment with nothing to answer before any spend', async () => {
    stored = event({ text: '🔥🔥 @friend' });
    await service.handle('t1', 'evt-1', NOW);
    expect(ledger.skip).toHaveBeenCalledWith('t1', 'evt-1', 'no_text', null);
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
