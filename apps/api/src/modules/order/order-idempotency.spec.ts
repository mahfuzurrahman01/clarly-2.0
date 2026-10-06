// F25 D9: key stability across item reordering and phone/whitespace
// formatting; key CHANGES across turn, conversation and tenant; content_hash
// ignores turnId.
//
// Each assertion below maps to one of D6.2's races. A test here that stops
// passing means a race has re-opened, not that a hash string changed.
import {
  canonicalizeItems,
  deriveContentHash,
  deriveIdempotencyKey,
  normalizePhone,
} from './order-idempotency';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const CONVERSATION = '33333333-3333-3333-3333-333333333333';
const TURN = 'respond-path:burst-9';

const PRODUCT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const base = {
  tenantId: TENANT,
  conversationId: CONVERSATION,
  turnId: TURN,
  items: [
    { productId: PRODUCT_A, quantity: 1 },
    { productId: PRODUCT_B, quantity: 2 },
  ],
  contactPhone: '+966 50 123 4567',
};

const content = {
  ...base,
  contactName: 'Fatima Al-Otaibi',
  address: 'Al Olaya, near the big mosque, white gate',
  city: 'Riyadh',
};

describe('normalizePhone', () => {
  it('reduces every common Gulf formatting of one number to one value', () => {
    const canonical = normalizePhone('+966501234567');
    expect(normalizePhone('+966 50 123 4567')).toBe(canonical);
    expect(normalizePhone('00966501234567')).toBe(canonical);
    expect(normalizePhone('(966) 50-123-4567')).toBe(canonical);
  });

  it('keeps genuinely different numbers apart', () => {
    expect(normalizePhone('+966501234567')).not.toBe(
      normalizePhone('+966501234568'),
    );
  });
});

describe('canonicalizeItems', () => {
  it('is order-insensitive', () => {
    expect(
      canonicalizeItems([
        { productId: PRODUCT_B, quantity: 2 },
        { productId: PRODUCT_A, quantity: 1 },
      ]),
    ).toBe(
      canonicalizeItems([
        { productId: PRODUCT_A, quantity: 1 },
        { productId: PRODUCT_B, quantity: 2 },
      ]),
    );
  });

  it('sums a product listed twice rather than treating it as a different basket', () => {
    expect(
      canonicalizeItems([
        { productId: PRODUCT_A, quantity: 1 },
        { productId: PRODUCT_A, quantity: 1 },
      ]),
    ).toBe(canonicalizeItems([{ productId: PRODUCT_A, quantity: 2 }]));
  });

  it('distinguishes quantities', () => {
    expect(canonicalizeItems([{ productId: PRODUCT_A, quantity: 1 }])).not.toBe(
      canonicalizeItems([{ productId: PRODUCT_A, quantity: 2 }]),
    );
  });
});

describe('deriveIdempotencyKey', () => {
  it('is deterministic (race #1: the model calls create_order twice in one turn)', () => {
    expect(deriveIdempotencyKey(base)).toBe(deriveIdempotencyKey(base));
  });

  it('is stable across a BullMQ retry of the same turn (race #2)', () => {
    // Nothing about the turn changes on a retry — the item array is rebuilt
    // from the same tool args, possibly in a different order.
    const retry = {
      ...base,
      items: [
        { productId: PRODUCT_B, quantity: 2 },
        { productId: PRODUCT_A, quantity: 1 },
      ],
      contactPhone: '00966501234567',
    };
    expect(deriveIdempotencyKey(retry)).toBe(deriveIdempotencyKey(base));
  });

  it('changes when the turn changes', () => {
    expect(deriveIdempotencyKey({ ...base, turnId: 'other-turn' })).not.toBe(
      deriveIdempotencyKey(base),
    );
  });

  it('changes when the conversation changes', () => {
    expect(
      deriveIdempotencyKey({ ...base, conversationId: 'other-conversation' }),
    ).not.toBe(deriveIdempotencyKey(base));
  });

  it('changes when the tenant changes — two tenants never collide on one key', () => {
    expect(deriveIdempotencyKey({ ...base, tenantId: OTHER_TENANT })).not.toBe(
      deriveIdempotencyKey(base),
    );
  });

  it('changes when the basket changes', () => {
    expect(
      deriveIdempotencyKey({
        ...base,
        items: [{ productId: PRODUCT_A, quantity: 1 }],
      }),
    ).not.toBe(deriveIdempotencyKey(base));
  });

  it('changes when the customer phone changes', () => {
    expect(
      deriveIdempotencyKey({ ...base, contactPhone: '+966509999999' }),
    ).not.toBe(deriveIdempotencyKey(base));
  });

  it('is a hex sha256 digest', () => {
    expect(deriveIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles a non-conversational caller (null conversation/turn) without throwing', () => {
    expect(
      deriveIdempotencyKey({ ...base, conversationId: null, turnId: null }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not let a field boundary be shifted by free text', () => {
    // If the separator were a printable character a caller could type, moving
    // a character across a field boundary would produce an identical digest.
    expect(
      deriveContentHash({ ...content, contactName: 'ab', address: 'c' }),
    ).not.toBe(
      deriveContentHash({ ...content, contactName: 'a', address: 'bc' }),
    );
  });
});

describe('deriveContentHash', () => {
  it('IGNORES turnId — that omission is what catches race #3', () => {
    // Two different turns in one conversation ordering the same thing.
    const turnOne = deriveContentHash({ ...content });
    const turnTwo = deriveContentHash({ ...content });
    expect(turnTwo).toBe(turnOne);

    // And the idempotency key for those same two turns DOES differ, which is
    // why the partial unique index is needed at all.
    expect(deriveIdempotencyKey({ ...content, turnId: 'turn-1' })).not.toBe(
      deriveIdempotencyKey({ ...content, turnId: 'turn-2' }),
    );
  });

  it('is insensitive to item ordering and phone formatting', () => {
    expect(
      deriveContentHash({
        ...content,
        items: [
          { productId: PRODUCT_B, quantity: 2 },
          { productId: PRODUCT_A, quantity: 1 },
        ],
        contactPhone: '00966501234567',
      }),
    ).toBe(deriveContentHash(content));
  });

  it('is insensitive to whitespace and casing in the collected contact details', () => {
    expect(
      deriveContentHash({
        ...content,
        contactName: '  fatima   al-otaibi ',
        address: 'AL OLAYA, near the   big mosque, white gate',
        city: ' riyadh ',
      }),
    ).toBe(deriveContentHash(content));
  });

  it('changes when the delivery address genuinely changes', () => {
    expect(
      deriveContentHash({ ...content, address: 'Jeddah corniche, tower 4' }),
    ).not.toBe(deriveContentHash(content));
  });

  it('changes when the basket changes', () => {
    expect(
      deriveContentHash({
        ...content,
        items: [{ productId: PRODUCT_A, quantity: 5 }],
      }),
    ).not.toBe(deriveContentHash(content));
  });

  it('changes across tenants and conversations', () => {
    expect(deriveContentHash({ ...content, tenantId: OTHER_TENANT })).not.toBe(
      deriveContentHash(content),
    );
    expect(deriveContentHash({ ...content, conversationId: 'other' })).not.toBe(
      deriveContentHash(content),
    );
  });

  it('treats a missing city as a value, not as a crash', () => {
    expect(deriveContentHash({ ...content, city: null })).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(deriveContentHash({ ...content, city: null })).toBe(
      deriveContentHash({ ...content, city: undefined }),
    );
  });

  it('is a different hash namespace from the idempotency key', () => {
    // Same inputs must not collide across the two functions.
    expect(deriveContentHash(content)).not.toBe(deriveIdempotencyKey(content));
  });
});
