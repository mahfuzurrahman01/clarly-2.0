// Feature 16: the Messenger / Instagram webhook parser.
//
// This is the most untrusted input the social path accepts, and the tests
// below are weighted accordingly: the echo case prevents an infinite
// self-answering loop, the unknown-object case prevents a retry storm, and
// the channel-tagging cases are what make one endpoint able to serve two
// products without a branch anywhere downstream.
import {
  parseMetaSocialComments,
  parseMetaSocialEnvelope,
  parseMetaSocialStatusUpdates,
} from './meta-social-envelope.parser';

const messengerBody = (
  messaging: Record<string, unknown>[],
  object = 'page',
  entryId = 'page-1',
) => JSON.stringify({ object, entry: [{ id: entryId, time: 1, messaging }] });

const textEvent = (overrides: Record<string, unknown> = {}) => ({
  sender: { id: 'PSID-1' },
  recipient: { id: 'page-1' },
  timestamp: 1788000000000,
  message: { mid: 'mid.abc', text: 'hello there' },
  ...overrides,
});

describe('parseMetaSocialEnvelope', () => {
  it('normalizes a Messenger text message onto the shared port vocabulary', () => {
    const [message] = parseMetaSocialEnvelope(messengerBody([textEvent()]));

    expect(message).toEqual({
      channel: 'messenger',
      channelAccountId: 'page-1',
      providerMessageId: 'mid.abc',
      from: 'PSID-1',
      type: 'text',
      text: 'hello there',
      receivedAt: new Date(1788000000000),
    });
  });

  it("tags an Instagram payload as 'instagram' from the envelope's own object field", () => {
    // This is what lets ONE endpoint serve both products: the channel is read
    // off the payload, never inferred from which adapter happened to parse it.
    const [message] = parseMetaSocialEnvelope(
      messengerBody([textEvent()], 'instagram', 'ig-1'),
    );

    expect(message.channel).toBe('instagram');
    expect(message.channelAccountId).toBe('ig-1');
  });

  it('DROPS our own echoed messages', () => {
    // Meta echoes messages we sent on the same subscription. Treating one as
    // inbound makes the agent answer itself — an infinite loop, billed per
    // turn. The single most expensive bug available on this integration.
    expect(
      parseMetaSocialEnvelope(
        messengerBody([
          textEvent({
            message: { mid: 'mid.echo', text: 'our reply', is_echo: true },
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('drops a deleted message and an event with no message at all', () => {
    expect(
      parseMetaSocialEnvelope(
        messengerBody([
          textEvent({ message: { mid: 'mid.x', is_deleted: true } }),
          { sender: { id: 'PSID-1' }, timestamp: 1 },
        ]),
      ),
    ).toEqual([]);
  });

  it('returns zero messages (not an error) for a Meta product we do not serve', () => {
    // Meta fans one app's subscriptions across products. Throwing here would
    // make it retry a delivery we correctly have nothing to do with.
    expect(
      parseMetaSocialEnvelope(
        messengerBody([textEvent()], 'whatsapp_business_account'),
      ),
    ).toEqual([]);
  });

  it("classifies attachments onto the port's fixed media vocabulary", () => {
    const cases: [string, string][] = [
      ['image', 'image'],
      ['audio', 'voice'],
      ['file', 'document'],
      ['video', 'unsupported'],
      ['story_mention', 'unsupported'],
    ];

    for (const [attachmentType, expected] of cases) {
      const [message] = parseMetaSocialEnvelope(
        messengerBody([
          textEvent({
            message: {
              mid: `mid.${attachmentType}`,
              attachments: [
                { type: attachmentType, payload: { url: 'https://cdn/x' } },
              ],
            },
          }),
        ]),
      );
      expect([attachmentType, message.type]).toEqual([
        attachmentType,
        expected,
      ]);
      // Gulf T6 (D9): a CDN url, named for what it is. Never a `mediaId`.
      expect(message.media?.mediaUrl).toBe('https://cdn/x');
      expect(message.media).not.toHaveProperty('mediaId');
    }
  });

  it('keeps the caption a customer typed alongside an attachment', () => {
    const [message] = parseMetaSocialEnvelope(
      messengerBody([
        textEvent({
          message: {
            mid: 'mid.img',
            text: 'how much is this?',
            attachments: [{ type: 'image', payload: { url: 'https://cdn/y' } }],
          },
        }),
      ]),
    );
    expect(message.media?.caption).toBe('how much is this?');
  });

  it('rejects a malformed envelope rather than emitting undefined downstream', () => {
    expect(() => parseMetaSocialEnvelope('{"object":"page"}')).toThrow(
      /unrecognized webhook envelope/i,
    );
    expect(() => parseMetaSocialEnvelope('not json')).toThrow(
      /not valid JSON/i,
    );
  });
});

describe('parseMetaSocialStatusUpdates', () => {
  it('maps delivery receipts to per-message status updates', () => {
    const updates = parseMetaSocialStatusUpdates(
      messengerBody([
        {
          sender: { id: 'PSID-1' },
          timestamp: 1788000000000,
          delivery: { mids: ['mid.out1', 'mid.out2'], watermark: 1 },
        },
      ]),
    );

    expect(updates).toEqual([
      expect.objectContaining({
        channel: 'messenger',
        providerMessageId: 'mid.out1',
        status: 'delivered',
      }),
      expect.objectContaining({ providerMessageId: 'mid.out2' }),
    ]);
  });

  it('ignores read receipts, which carry a watermark and no message id', () => {
    // There is nothing to match a stored message on. Reporting one would mean
    // guessing which rows it covers; showing 'delivered' is honest, a
    // fabricated 'read' is not.
    expect(
      parseMetaSocialStatusUpdates(
        messengerBody([{ sender: { id: 'x' }, read: { watermark: 123 } }]),
      ),
    ).toEqual([]);
  });

  it('returns nothing for a malformed body rather than throwing', () => {
    // Status parsing runs unconditionally on every webhook; throwing here
    // would reject a delivery that carried real customer messages.
    expect(parseMetaSocialStatusUpdates('nonsense')).toEqual([]);
  });
});

// Gulf T8 (D6): the comment branch. Shapes follow Meta's documented page
// `feed` field (verb/item/comment_id/post_id/from/message/created_time) and
// the Instagram `comments` field (Facebook Login form: comment_id, from.id is
// the IGSID, media.id + media_product_type; Business Login form: `id`).
describe('parseMetaSocialComments', () => {
  const pageFeedBody = (value: Record<string, unknown>, entryId = 'page-1') =>
    JSON.stringify({
      object: 'page',
      entry: [
        { id: entryId, time: 1788000000, changes: [{ field: 'feed', value }] },
      ],
    });
  const igBody = (value: Record<string, unknown>, entryId = 'ig-1') =>
    JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: entryId,
          time: 1788000000,
          changes: [{ field: 'comments', value }],
        },
      ],
    });
  const feedComment = (overrides: Record<string, unknown> = {}) => ({
    from: { id: 'user-9', name: 'Sara' },
    post: { id: 'page-1_post-1', status_type: 'added_photos' },
    message: 'price?',
    post_id: 'page-1_post-1',
    comment_id: 'post-1_comment-1',
    created_time: 1788000000,
    item: 'comment',
    parent_id: 'page-1_post-1',
    verb: 'add',
    ...overrides,
  });

  it('normalizes a Facebook page feed comment', () => {
    expect(parseMetaSocialComments(pageFeedBody(feedComment()))).toEqual([
      {
        channel: 'messenger',
        channelAccountId: 'page-1',
        commentId: 'post-1_comment-1',
        postId: 'page-1_post-1',
        parentId: 'page-1_post-1',
        authorId: 'user-9',
        authorName: 'Sara',
        text: 'price?',
        verb: 'add',
        mediaProductType: null,
        createdAt: new Date(1788000000 * 1000),
      },
    ]);
  });

  it('keeps the verb so the caller can ignore edits and removals (D6)', () => {
    const [edited] = parseMetaSocialComments(
      pageFeedBody(feedComment({ verb: 'edited' })),
    );
    expect(edited.verb).toBe('edited');
  });

  it('ignores feed items that are not comments (posts, reactions, shares)', () => {
    expect(
      parseMetaSocialComments(pageFeedBody(feedComment({ item: 'reaction' }))),
    ).toEqual([]);
    expect(
      parseMetaSocialComments(pageFeedBody(feedComment({ item: 'status' }))),
    ).toEqual([]);
  });

  it('skips a feed comment with no author or no comment id rather than throwing', () => {
    expect(
      parseMetaSocialComments(pageFeedBody(feedComment({ from: undefined }))),
    ).toEqual([]);
    expect(
      parseMetaSocialComments(
        pageFeedBody(feedComment({ comment_id: undefined })),
      ),
    ).toEqual([]);
  });

  it('falls back to the entry time when created_time is missing', () => {
    const [comment] = parseMetaSocialComments(
      pageFeedBody(feedComment({ created_time: undefined })),
    );
    expect(comment.createdAt).toEqual(new Date(1788000000 * 1000));
  });

  it('normalizes an Instagram comment (Facebook Login shape) as verb add', () => {
    const [comment] = parseMetaSocialComments(
      igBody({
        from: { id: 'IGSID-1', username: 'buyer' },
        comment_id: 'ig-comment-1',
        parent_id: 'ig-comment-0',
        text: 'بكم؟',
        media: { id: 'media-1', media_product_type: 'REELS' },
      }),
    );
    expect(comment).toEqual({
      channel: 'instagram',
      channelAccountId: 'ig-1',
      commentId: 'ig-comment-1',
      postId: 'media-1',
      parentId: 'ig-comment-0',
      authorId: 'IGSID-1',
      authorName: 'buyer',
      text: 'بكم؟',
      verb: 'add',
      mediaProductType: 'REELS',
      createdAt: new Date(1788000000 * 1000),
    });
  });

  it('accepts the Business Login Instagram shape, where the comment id is `id`', () => {
    const [comment] = parseMetaSocialComments(
      igBody({
        id: 'ig-comment-2',
        from: { id: 'IGSID-2', username: 'x' },
        text: 'how much',
        media: { id: 'media-2', media_product_type: 'FEED' },
      }),
    );
    expect(comment.commentId).toBe('ig-comment-2');
    expect(comment.parentId).toBeNull();
  });

  it('ignores other change fields and DM-only envelopes', () => {
    expect(
      parseMetaSocialComments(
        JSON.stringify({
          object: 'instagram',
          entry: [
            {
              id: 'ig-1',
              changes: [{ field: 'mentions', value: { media_id: 'm' } }],
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(parseMetaSocialComments(messengerBody([textEvent()]))).toEqual([]);
  });

  it('returns nothing for a product we do not serve and throws on a malformed envelope', () => {
    expect(
      parseMetaSocialComments(
        JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
      ),
    ).toEqual([]);
    expect(() => parseMetaSocialComments('{not json')).toThrow();
    expect(() =>
      parseMetaSocialComments(JSON.stringify({ entry: 1 })),
    ).toThrow();
  });

  it('does not turn a comment change into a DM', () => {
    expect(parseMetaSocialEnvelope(pageFeedBody(feedComment()))).toEqual([]);
  });
});
