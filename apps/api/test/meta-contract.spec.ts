// T9 (D10): Meta Graph contract tests.
//
// Validates that scrubbed, recorded Meta webhook payloads parse into the
// expected normalized shapes. Run via `npm run test:meta-contract`.
//
// Nightly and before App Review submission against the dev app — ensures
// Meta's wire format hasn't shifted and our parsers still produce the
// shapes the downstream pipeline (ingest, respond-path, comments) expects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseMetaEnvelope,
  parseMetaMessageEchoes,
  parseMetaStatusUpdates,
} from '../src/modules/whatsapp/meta-envelope.parser';
import {
  parseMetaSocialComments,
  parseMetaSocialEnvelope,
  parseMetaSocialStatusUpdates,
} from '../src/modules/meta-channel/meta-social-envelope.parser';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'meta');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// WhatsApp inbound messages
// ---------------------------------------------------------------------------
describe('T9 contract: WhatsApp text message', () => {
  const raw = loadFixture('whatsapp-message-text.json');

  it('parses into a NormalizedInboundMessage with phoneNumberId and bspMessageId', () => {
    const [msg] = parseMetaEnvelope(raw, 't9-contract');

    expect(msg).toBeDefined();
    expect(msg.phoneNumberId).toBe('pn-test-text-001');
    expect(msg.bspMessageId).toBe('wamid.text001');
    expect(msg.from).toBe('966501234567');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Hello, do you deliver to Riyadh?');
    expect(msg.media).toBeUndefined();
    expect(msg.receivedAt).toEqual(new Date(1788000000 * 1000));
  });
});

describe('T9 contract: WhatsApp image message', () => {
  const raw = loadFixture('whatsapp-message-image.json');

  it('parses with image media descriptor', () => {
    const [msg] = parseMetaEnvelope(raw, 't9-contract');

    expect(msg).toBeDefined();
    expect(msg.phoneNumberId).toBe('pn-test-image-002');
    expect(msg.bspMessageId).toBe('wamid.image001');
    expect(msg.type).toBe('image');
    expect(msg.text).toBeUndefined();
    expect(msg.media).toEqual({
      mediaId: 'MEDIA_IMG_001',
      mimeType: 'image/jpeg',
      filename: null,
      caption: 'What is the price of this item?',
    });
  });
});

// ---------------------------------------------------------------------------
// WhatsApp status updates
// ---------------------------------------------------------------------------
describe('T9 contract: WhatsApp delivered status', () => {
  const raw = loadFixture('whatsapp-status-delivered.json');

  it('parses into a NormalizedStatusUpdate with status=delivered', () => {
    const [status] = parseMetaStatusUpdates(raw);

    expect(status).toBeDefined();
    expect(status.phoneNumberId).toBe('pn-test-status-003');
    expect(status.bspMessageId).toBe('wamid.status001');
    expect(status.status).toBe('delivered');
    expect(status.error).toBeNull();
    expect(status.occurredAt).toEqual(new Date(1788000200 * 1000));
  });
});

describe('T9 contract: WhatsApp failed status (code 190)', () => {
  const raw = loadFixture('whatsapp-status-failed.json');

  it('parses with error detail and status=failed', () => {
    const [status] = parseMetaStatusUpdates(raw);

    expect(status).toBeDefined();
    expect(status.phoneNumberId).toBe('pn-test-status-004');
    expect(status.bspMessageId).toBe('wamid.fail001');
    expect(status.status).toBe('failed');
    expect(status.error).toContain('190');
    expect(status.error).toContain('account security');
  });
});

// ---------------------------------------------------------------------------
// WhatsApp coexistence echoes (D13)
// ---------------------------------------------------------------------------
describe('T9 contract: WhatsApp message echo (coexistence)', () => {
  const raw = loadFixture('whatsapp-message-echo.json');

  it('parses into a NormalizedMessageEcho with to and sentAt', () => {
    const [echo] = parseMetaMessageEchoes(raw);

    expect(echo).toBeDefined();
    expect(echo.phoneNumberId).toBe('pn-test-echo-005');
    expect(echo.bspMessageId).toBe('wamid.echo001');
    expect(echo.to).toBe('966501234567');
    expect(echo.type).toBe('text');
    expect(echo.text).toBe(
      'Thank you for your message. We will get back to you shortly.',
    );
    expect(echo.sentAt).toEqual(new Date(1788000400 * 1000));
  });

  it('echo is NOT treated as an inbound message (D13: never triggers AI)', () => {
    // parseMetaEnvelope on the same body should yield zero messages —
    // the echo field (smb_message_echoes) is not in the inbound schema.
    const messages = parseMetaEnvelope(raw, 't9-contract');
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Messenger DMs
// ---------------------------------------------------------------------------
describe('T9 contract: Messenger text DM', () => {
  const raw = loadFixture('messenger-text.json');

  it('parses with channel=messenger and providerMessageId from mid', () => {
    const [msg] = parseMetaSocialEnvelope(raw);

    expect(msg).toBeDefined();
    expect(msg.channel).toBe('messenger');
    expect(msg.channelAccountId).toBe('page-messenger-001');
    expect(msg.providerMessageId).toBe('mid.messenger001');
    expect(msg.from).toBe('PSID-100001');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Do you have this in blue?');
    expect(msg.receivedAt).toEqual(new Date(1788000000000));
  });
});

describe('T9 contract: Messenger image DM', () => {
  const raw = loadFixture('messenger-image.json');

  it('parses with mediaUrl from the CDN payload', () => {
    const [msg] = parseMetaSocialEnvelope(raw);

    expect(msg).toBeDefined();
    expect(msg.channel).toBe('messenger');
    expect(msg.type).toBe('image');
    expect(msg.media).toBeDefined();
    expect(msg.media!.mediaUrl).toBe(
      'https://lookaside.fbsbx.com/test-image.jpg?token=abc123',
    );
    expect(msg.media!.mimeType).toBeNull();
  });
});

describe('T9 contract: Messenger echo is dropped', () => {
  const raw = loadFixture('messenger-echo.json');

  it('returns zero messages for an is_echo message (infinite-loop prevention)', () => {
    const messages = parseMetaSocialEnvelope(raw);
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Instagram DMs
// ---------------------------------------------------------------------------
describe('T9 contract: Instagram text DM', () => {
  const raw = loadFixture('instagram-text.json');

  it('tags channel as instagram from the envelope object field', () => {
    const [msg] = parseMetaSocialEnvelope(raw);

    expect(msg).toBeDefined();
    expect(msg.channel).toBe('instagram');
    expect(msg.channelAccountId).toBe('ig-account-001');
    expect(msg.providerMessageId).toBe('mid.ig001');
    expect(msg.from).toBe('IGSID-200001');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('How much is this?');
  });
});

// ---------------------------------------------------------------------------
// Comment automation (F23 / D6)
// ---------------------------------------------------------------------------
describe('T9 contract: Facebook page feed comment', () => {
  const raw = loadFixture('instagram-comment-feed.json');

  it('parses a feed comment with verb, authorName, and postId', () => {
    const [comment] = parseMetaSocialComments(raw);

    expect(comment).toBeDefined();
    expect(comment.channel).toBe('messenger');
    expect(comment.channelAccountId).toBe('page-comment-001');
    expect(comment.commentId).toBe('fb-comment-001');
    expect(comment.postId).toBe('page-comment-001_post-001');
    expect(comment.parentId).toBe('page-comment-001_post-001');
    expect(comment.authorId).toBe('FBUSER-300001');
    expect(comment.authorName).toBe('Ahmad');
    expect(comment.text).toBe('price?');
    expect(comment.verb).toBe('add');
    expect(comment.mediaProductType).toBeNull();
    expect(comment.createdAt).toEqual(new Date(1788000000 * 1000));
  });

  it('feed comment does NOT appear as a DM', () => {
    const messages = parseMetaSocialEnvelope(raw);
    expect(messages).toEqual([]);
  });
});

describe('T9 contract: Instagram comment (REELS)', () => {
  const raw = loadFixture('instagram-comment-ig.json');

  it('parses with channel=instagram, verb=add, and mediaProductType', () => {
    const [comment] = parseMetaSocialComments(raw);

    expect(comment).toBeDefined();
    expect(comment.channel).toBe('instagram');
    expect(comment.channelAccountId).toBe('ig-comment-001');
    expect(comment.commentId).toBe('ig-comment-001');
    expect(comment.postId).toBe('ig-media-001');
    expect(comment.parentId).toBe('ig-comment-parent-001');
    expect(comment.authorId).toBe('IGSID-300002');
    expect(comment.authorName).toBe('buyer_sa');
    expect(comment.text).toBe('بكم؟');
    expect(comment.verb).toBe('add');
    expect(comment.mediaProductType).toBe('REELS');
  });
});

describe('T9 contract: comment replay (webhook dedup)', () => {
  const raw = loadFixture('instagram-comment-replay.json');

  it('returns the same commentId on replay (ledger idempotency check)', () => {
    const [comment] = parseMetaSocialComments(raw);
    expect(comment).toBeDefined();
    expect(comment.commentId).toBe('ig-comment-001');
    // The ledger's unique(channel, comment_id) constraint handles dedup;
    // the parser correctly returns the same id on replay.
  });
});

// ---------------------------------------------------------------------------
// Social status updates (Messenger delivery receipts)
// ---------------------------------------------------------------------------
describe('T9 contract: Messenger delivery receipt', () => {
  const body = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: 'page-status-001',
        time: 1788000000,
        messaging: [
          {
            sender: { id: 'page-status-001' },
            recipient: { id: 'PSID-100001' },
            timestamp: 1788000500000,
            delivery: {
              mids: ['mid.status001'],
              watermark: 1788000500000,
            },
          },
        ],
      },
    ],
  });

  it('parses delivery.mids into NormalizedStatusUpdate', () => {
    const [update] = parseMetaSocialStatusUpdates(body);

    expect(update).toBeDefined();
    expect(update.channel).toBe('messenger');
    expect(update.channelAccountId).toBe('page-status-001');
    expect(update.providerMessageId).toBe('mid.status001');
    expect(update.status).toBe('delivered');
    expect(update.error).toBeNull();
  });
});
