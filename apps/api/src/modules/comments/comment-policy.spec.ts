import {
  canSendPrivateReply,
  decideForIntent,
  labelForCommentIntent,
  parseCommentIntent,
  prefilterComment,
  PRIVATE_REPLY_WINDOW_MS,
} from './comment-policy';

const rules = {
  keywordTriggers: ['price', 'بكم'],
  spamKeywords: ['crypto', 'follow back'],
  replyIntents: ['purchase', 'question'] as ('purchase' | 'question')[],
  hideSpam: true,
};

describe('prefilterComment (D11 tier 1: rules)', () => {
  it('flags a spam keyword before anything else, even when a trigger also matches', () => {
    expect(prefilterComment('price? earn crypto fast', rules)).toEqual({
      kind: 'spam',
      matched: 'crypto',
    });
  });

  it('answers a trigger keyword without classifying', () => {
    expect(prefilterComment('بِكَم؟', rules)).toEqual({
      kind: 'trigger',
      matched: 'بكم',
    });
  });

  it('ignores a comment with nothing to answer', () => {
    expect(prefilterComment('🔥🔥', rules)).toEqual({
      kind: 'ignore',
      reason: 'no_text',
    });
    expect(prefilterComment('@friend', rules)).toEqual({
      kind: 'ignore',
      reason: 'no_text',
    });
  });

  it('sends everything else to the classifier', () => {
    expect(prefilterComment('do you deliver to Riyadh', rules)).toEqual({
      kind: 'classify',
    });
  });
});

describe('parseCommentIntent', () => {
  it.each([
    ['purchase', 'purchase'],
    [' Question.\n', 'question'],
    ['intent: spam', 'spam'],
    ['ABUSE', 'abuse'],
    ['complaint', 'complaint'],
    ['I think this is other', 'other'],
    ['no idea', 'other'],
    ['', 'other'],
  ])('%p -> %p', (raw, expected) => {
    expect(parseCommentIntent(raw)).toBe(expected);
  });
});

describe('decideForIntent (D11 tier 2 -> tier 3 gate)', () => {
  it('replies only to the intents the tenant enabled', () => {
    expect(decideForIntent('purchase', rules)).toBe('reply');
    expect(decideForIntent('question', rules)).toBe('reply');
    expect(
      decideForIntent('question', { ...rules, replyIntents: ['purchase'] }),
    ).toBe('none');
  });

  it('hides spam and abuse, never answers them', () => {
    expect(decideForIntent('spam', rules)).toBe('hide');
    expect(decideForIntent('abuse', rules)).toBe('hide');
    expect(decideForIntent('spam', { ...rules, hideSpam: false })).toBe('none');
  });

  it('does nothing for complaints and chatter', () => {
    expect(decideForIntent('complaint', rules)).toBe('none');
    expect(decideForIntent('other', rules)).toBe('none');
  });
});

describe('canSendPrivateReply', () => {
  const now = new Date('2026-09-19T12:00:00Z');

  it('is open inside the 7-day window and shut after it', () => {
    expect(canSendPrivateReply(new Date(now.getTime() - 60_000), now)).toBe(
      true,
    );
    expect(
      canSendPrivateReply(
        new Date(now.getTime() - PRIVATE_REPLY_WINDOW_MS - 1),
        now,
      ),
    ).toBe(false);
  });

  it('keeps a safety margin under Meta’s 7 days', () => {
    expect(PRIVATE_REPLY_WINDOW_MS).toBeLessThan(7 * 24 * 60 * 60 * 1000);
  });
});

describe('labelForCommentIntent (F18 vocabulary)', () => {
  it('maps buying signals to the F18 labels', () => {
    expect(labelForCommentIntent('purchase')).toBe('hot');
    expect(labelForCommentIntent('keyword')).toBe('hot');
    expect(labelForCommentIntent('question')).toBe('warm');
    expect(labelForCommentIntent('other')).toBeNull();
    expect(labelForCommentIntent(null)).toBeNull();
  });
});
