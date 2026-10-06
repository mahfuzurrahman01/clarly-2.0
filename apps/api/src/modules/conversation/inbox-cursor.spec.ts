import { decodeCursor, encodeCursor } from './inbox-cursor';

const ID = '11111111-2222-4333-8444-555555555555';

describe('inbox cursor', () => {
  it('round-trips a timestamp and id', () => {
    const at = new Date('2026-08-18T10:11:12.345Z');
    expect(decodeCursor(encodeCursor({ at, id: ID }))).toEqual({ at, id: ID });
  });

  it('preserves sub-second precision — a coalesced burst writes several messages inside the same second, so a truncated cursor would replay or skip rows', () => {
    const at = new Date('2026-08-18T10:11:12.007Z');
    expect(decodeCursor(encodeCursor({ at, id: ID }))?.at.toISOString()).toBe(
      '2026-08-18T10:11:12.007Z',
    );
  });

  it.each([
    ['not base64 at all', '!!!not-base64!!!'],
    [
      'no separator',
      Buffer.from('2026-08-18T10:11:12.345Z').toString('base64url'),
    ],
    ['unparseable timestamp', Buffer.from(`never|${ID}`).toString('base64url')],
    [
      'non-uuid id',
      Buffer.from('2026-08-18T10:11:12.345Z|not-a-uuid').toString('base64url'),
    ],
    ['empty', ''],
  ])('returns null for a malformed cursor (%s)', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});
