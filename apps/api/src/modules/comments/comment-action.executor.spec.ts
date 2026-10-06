import type { AppLoggerService } from '../core';
import {
  MetaGraphError,
  type MetaGraphClient,
} from '../meta-graph/meta-graph.module';
import type { MetaTokenService } from '../meta-channel/meta-token.service';
import type { SocialChannelResolutionService } from '../meta-channel/social-channel-resolution.service';
import { SocialChannelReconnectRequiredError } from '../meta-channel/social-channel.errors';
import type { CommentActionStatus } from '../persistence/drizzle/schema';
import {
  CommentActionExecutor,
  META_THROTTLE_BACKOFF_MS,
} from './comment-action.executor';
import type { CommentLedgerService } from './comment-ledger.service';
import type { CommentRateLimiter } from './comment-rate-limiter.service';
import { CommentDeferredError } from './comment.errors';

/** An in-memory stand-in for the comment_actions claim semantics. */
function fakeLedger() {
  const actions = new Map<string, CommentActionStatus>();
  return {
    actions,
    claimAction: jest.fn(
      (_t: string, _e: string, commentId: string, action: string) => {
        const key = `${commentId}:${action}`;
        const existing = actions.get(key);
        if (existing === undefined || existing === 'released') {
          actions.set(key, 'claimed');
          return Promise.resolve('claimed');
        }
        return Promise.resolve(existing === 'claimed' ? 'held' : existing);
      },
    ),
    finishAction: jest.fn(
      (
        _t: string,
        commentId: string,
        action: string,
        outcome: { status: CommentActionStatus },
      ) => {
        actions.set(`${commentId}:${action}`, outcome.status);
        return Promise.resolve();
      },
    ),
    recordPrivateReplySent: jest.fn().mockResolvedValue(undefined),
  };
}

describe('CommentActionExecutor', () => {
  const now = new Date('2026-09-19T10:00:00Z');
  const fbEvent = {
    id: 'evt-1',
    tenantId: 't1',
    channel: 'messenger' as const,
    channelAccountId: 'page-1',
    commentId: 'c-1',
  };
  const igEvent = {
    ...fbEvent,
    id: 'evt-2',
    channel: 'instagram' as const,
    channelAccountId: 'ig-1',
    commentId: 'igc-1',
  };

  let ledger: ReturnType<typeof fakeLedger>;
  let graph: {
    hideComment: jest.Mock;
    replyToComment: jest.Mock;
    sendPrivateReply: jest.Mock;
  };
  let tokens: { ensureFreshToken: jest.Mock };
  let limiter: { privateReply: jest.Mock };
  let executor: CommentActionExecutor;

  beforeEach(() => {
    ledger = fakeLedger();
    graph = {
      hideComment: jest.fn().mockResolvedValue(undefined),
      replyToComment: jest.fn().mockResolvedValue({ id: 'reply-1' }),
      sendPrivateReply: jest
        .fn()
        .mockResolvedValue({ recipientId: 'PSID-1', messageId: 'mid.1' }),
    };
    tokens = { ensureFreshToken: jest.fn().mockResolvedValue('PAGE_TOKEN') };
    limiter = { privateReply: jest.fn().mockResolvedValue({ allowed: true }) };
    executor = new CommentActionExecutor(
      ledger as unknown as CommentLedgerService,
      graph as unknown as MetaGraphClient,
      tokens as unknown as MetaTokenService,
      {
        resolve: jest.fn((id: string) =>
          Promise.resolve({ pageId: id === 'ig-1' ? 'page-9' : id }),
        ),
      } as unknown as SocialChannelResolutionService,
      limiter as unknown as CommentRateLimiter,
      { warn: jest.fn(), log: jest.fn() } as unknown as AppLoggerService,
    );
  });

  it('posts a public reply once, and a replay finds it already done (D6)', async () => {
    await expect(executor.publicReply(fbEvent, 'DM sent')).resolves.toBe(
      'succeeded',
    );
    await expect(executor.publicReply(fbEvent, 'DM sent')).resolves.toBe(
      'already_done',
    );
    expect(graph.replyToComment).toHaveBeenCalledTimes(1);
    expect(graph.replyToComment).toHaveBeenCalledWith({
      surface: 'facebook',
      commentId: 'c-1',
      message: 'DM sent',
      pageAccessToken: 'PAGE_TOKEN',
    });
    expect(ledger.finishAction).toHaveBeenCalledWith(
      't1',
      'c-1',
      'public_reply',
      { status: 'succeeded', providerRef: 'reply-1' },
    );
  });

  it('claims BEFORE the Graph call', async () => {
    const order: string[] = [];
    ledger.claimAction.mockImplementationOnce(() => {
      order.push('claim');
      return Promise.resolve('claimed');
    });
    graph.hideComment.mockImplementationOnce(() => {
      order.push('graph');
      return Promise.resolve();
    });
    await executor.hide(fbEvent);
    expect(order).toEqual(['claim', 'graph']);
  });

  it('sends the private reply through the linked PAGE and opens the D15b thread', async () => {
    await expect(executor.privateReply(igEvent, 'details', now)).resolves.toBe(
      'succeeded',
    );
    expect(graph.sendPrivateReply).toHaveBeenCalledWith({
      pageId: 'page-9',
      commentId: 'igc-1',
      text: 'details',
      pageAccessToken: 'PAGE_TOKEN',
    });
    expect(ledger.recordPrivateReplySent).toHaveBeenCalledWith('t1', 'evt-2', {
      recipientId: 'PSID-1',
      messageId: 'mid.1',
      sentAt: now,
    });
  });

  it('defers (never drops) an Instagram private reply over the hourly limit, releasing the claim', async () => {
    limiter.privateReply.mockResolvedValue({
      allowed: false,
      retryAfterMs: 1_200_000,
    });

    const error = await executor
      .privateReply(igEvent, 'details', now)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommentDeferredError);
    expect((error as CommentDeferredError).delayMs).toBe(1_200_000);
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
    expect(ledger.actions.get('igc-1:private_reply')).toBe('released');

    // The deferred job comes back later and can take the claim again.
    limiter.privateReply.mockResolvedValue({ allowed: true });
    await expect(executor.privateReply(igEvent, 'details', now)).resolves.toBe(
      'succeeded',
    );
    expect(graph.sendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it('turns Meta throttling into a deferral too', async () => {
    graph.sendPrivateReply.mockRejectedValueOnce(
      new MetaGraphError(
        400,
        613,
        null,
        'Calls to this api have exceeded the rate limit.',
      ),
    );
    const error = await executor
      .privateReply(igEvent, 'details', now)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommentDeferredError);
    expect((error as CommentDeferredError).delayMs).toBe(
      META_THROTTLE_BACKOFF_MS,
    );
    expect(ledger.actions.get('igc-1:private_reply')).toBe('released');
  });

  it('marks an unknown outcome failed and never repeats it (at most once)', async () => {
    graph.sendPrivateReply.mockRejectedValueOnce(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    await expect(executor.privateReply(fbEvent, 'x', now)).resolves.toBe(
      'failed',
    );
    await expect(executor.privateReply(fbEvent, 'x', now)).resolves.toBe(
      'failed',
    );
    expect(graph.sendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it('records a refusal as failed', async () => {
    graph.hideComment.mockRejectedValueOnce(
      new MetaGraphError(400, 100, null, 'Unsupported post request'),
    );
    await expect(executor.hide(igEvent)).resolves.toBe('failed');
    expect(ledger.finishAction).toHaveBeenLastCalledWith(
      't1',
      'igc-1',
      'hide',
      { status: 'failed', error: 'Unsupported post request' },
    );
  });

  it('does nothing on a degraded channel beyond recording why', async () => {
    tokens.ensureFreshToken.mockRejectedValueOnce(
      new SocialChannelReconnectRequiredError('page-1', 'token expired'),
    );
    await expect(executor.publicReply(fbEvent, 'x')).resolves.toBe('failed');
    expect(graph.replyToComment).not.toHaveBeenCalled();
  });

  it('never runs an action another attempt still holds', async () => {
    ledger.actions.set('c-1:hide', 'claimed');
    await expect(executor.hide(fbEvent)).resolves.toBe('failed');
    expect(graph.hideComment).not.toHaveBeenCalled();
  });
});
