import type { Queue } from 'bullmq';
import type { AppLoggerService } from '../core';
import type { SocialChannelResolutionService } from '../meta-channel/social-channel-resolution.service';
import { UnknownSocialChannelError } from '../meta-channel/social-channel.errors';
import type { TenantStatusService } from '../tenant-context/tenant-status.service';
import { COMMENT_AUTOMATION_JOB } from './comment-automation.queue';
import { CommentIngestService } from './comment-ingest.service';
import type { CommentLedgerService } from './comment-ledger.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

function feedBody(value: Record<string, unknown>, entryId = 'page-1') {
  return JSON.stringify({
    object: 'page',
    entry: [
      { id: entryId, time: 1788000000, changes: [{ field: 'feed', value }] },
    ],
  });
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    item: 'comment',
    verb: 'add',
    comment_id: 'c-1',
    post_id: 'page-1_p-1',
    from: { id: 'user-1', name: 'Sara' },
    message: 'price?',
    created_time: 1788000000,
    ...overrides,
  };
}

describe('CommentIngestService', () => {
  let resolve: jest.Mock;
  let isClosed: jest.Mock;
  let recordReceived: jest.Mock;
  let add: jest.Mock;
  let service: CommentIngestService;

  beforeEach(() => {
    resolve = jest.fn().mockResolvedValue({
      tenantId: 't1',
      pageId: 'page-1',
      channel: 'messenger',
    });
    isClosed = jest.fn().mockResolvedValue(false);
    recordReceived = jest
      .fn()
      .mockResolvedValue({ id: EVENT_ID, isNew: true, status: 'received' });
    add = jest.fn().mockResolvedValue({});
    service = new CommentIngestService(
      { resolve } as unknown as SocialChannelResolutionService,
      { isClosed } as unknown as TenantStatusService,
      { recordReceived } as unknown as CommentLedgerService,
      { add } as unknown as Queue<{
        tenantId: string;
        commentEventId: string;
      }>,
      { warn: jest.fn() } as unknown as AppLoggerService,
    );
  });

  it('records a new comment and enqueues one job keyed by the ledger id', async () => {
    await expect(service.ingest(feedBody(comment()))).resolves.toEqual([
      { commentId: 'c-1', outcome: 'enqueued' },
    ]);
    expect(recordReceived).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ commentId: 'c-1', channelAccountId: 'page-1' }),
    );
    expect(add).toHaveBeenCalledWith(
      COMMENT_AUTOMATION_JOB,
      { tenantId: 't1', commentEventId: EVENT_ID },
      { jobId: `comment-${EVENT_ID}` },
    );
  });

  it('treats a webhook replay as a duplicate and enqueues nothing (D6)', async () => {
    recordReceived.mockResolvedValue({
      id: EVENT_ID,
      isNew: false,
      status: 'completed',
    });
    await expect(service.ingest(feedBody(comment()))).resolves.toEqual([
      { commentId: 'c-1', outcome: 'duplicate' },
    ]);
    expect(add).not.toHaveBeenCalled();
  });

  it('re-queues a replayed comment that never got past received', async () => {
    recordReceived.mockResolvedValue({
      id: EVENT_ID,
      isNew: false,
      status: 'received',
    });
    await expect(service.ingest(feedBody(comment()))).resolves.toEqual([
      { commentId: 'c-1', outcome: 'requeued' },
    ]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('only triggers on verb add (D6)', async () => {
    await expect(
      service.ingest(feedBody(comment({ verb: 'edited' }))),
    ).resolves.toEqual([{ commentId: 'c-1', outcome: 'ignored_verb' }]);
    await service.ingest(feedBody(comment({ verb: 'remove' })));
    expect(recordReceived).not.toHaveBeenCalled();
  });

  it('drops comments authored by the page itself, including our own replies (D6)', async () => {
    await expect(
      service.ingest(
        feedBody(comment({ from: { id: 'page-1', name: 'Shop' } })),
      ),
    ).resolves.toEqual([{ commentId: 'c-1', outcome: 'own_comment' }]);
    expect(resolve).not.toHaveBeenCalled();
    expect(recordReceived).not.toHaveBeenCalled();
  });

  it('drops an Instagram comment by the IG account or its linked page', async () => {
    resolve.mockResolvedValue({
      tenantId: 't1',
      pageId: 'page-9',
      channel: 'instagram',
    });
    const igBody = (fromId: string) =>
      JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: 'ig-1',
            time: 1788000000,
            changes: [
              {
                field: 'comments',
                value: {
                  comment_id: 'igc-1',
                  from: { id: fromId, username: 'shop' },
                  text: 'thanks!',
                  media: { id: 'm-1', media_product_type: 'REELS' },
                },
              },
            ],
          },
        ],
      });
    await expect(service.ingest(igBody('ig-1'))).resolves.toEqual([
      { commentId: 'igc-1', outcome: 'own_comment' },
    ]);
    await expect(service.ingest(igBody('page-9'))).resolves.toEqual([
      { commentId: 'igc-1', outcome: 'own_comment' },
    ]);
    expect(recordReceived).not.toHaveBeenCalled();
  });

  it('ignores an account no tenant has connected instead of failing the delivery', async () => {
    resolve.mockRejectedValue(new UnknownSocialChannelError('page-1'));
    await expect(service.ingest(feedBody(comment()))).resolves.toEqual([
      { commentId: 'c-1', outcome: 'unknown_account' },
    ]);
  });

  it('records nothing for a closed workspace', async () => {
    isClosed.mockResolvedValue(true);
    await expect(service.ingest(feedBody(comment()))).resolves.toEqual([
      { commentId: 'c-1', outcome: 'workspace_closed' },
    ]);
    expect(recordReceived).not.toHaveBeenCalled();
  });

  it('does nothing for a DM-only webhook', async () => {
    const dm = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            { sender: { id: 'P' }, message: { mid: 'm', text: 'hi' } },
          ],
        },
      ],
    });
    await expect(service.ingest(dm)).resolves.toEqual([]);
  });
});
