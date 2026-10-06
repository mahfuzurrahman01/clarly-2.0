import {
  decodeTenantCursor,
  encodeTenantCursor,
  escapeLike,
} from './platform-tenants.service';

const ID = '33333333-3333-4333-8333-333333333333';

describe('platform tenant cursor', () => {
  // Microseconds survive: a millisecond cursor silently ended the list when
  // two tenants shared one statement's now().
  it('round-trips a microsecond timestamp and id exactly', () => {
    const createdAt = '2026-10-06T08:09:10.123456Z';
    const decoded = decodeTenantCursor(encodeTenantCursor(createdAt, ID));
    expect(decoded).toEqual({ createdAt, id: ID });
  });

  it.each([
    ['not base64 at all', '%%%'],
    ['no separator', Buffer.from('2026-10-06T00:00:00Z').toString('base64url')],
    ['bad date', Buffer.from(`nope|${ID}`).toString('base64url')],
    [
      'millisecond timestamp',
      Buffer.from(`2026-10-06T08:09:10.123Z|${ID}`).toString('base64url'),
    ],
    [
      'extra segment',
      Buffer.from(`2026-10-06T08:09:10.123456Z|${ID}|x`).toString('base64url'),
    ],
    // The id lands in a SQL predicate (as a bound parameter); anything that is
    // not uuid-shaped is refused before it gets that far.
    [
      'non-uuid id',
      Buffer.from('2026-10-06T00:00:00Z|1 or 1=1').toString('base64url'),
    ],
  ])('returns null for %s', (_label, cursor) => {
    expect(decodeTenantCursor(cursor)).toBeNull();
  });
});

describe('escapeLike', () => {
  it('escapes LIKE metacharacters so they match literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves ordinary text alone, including Arabic', () => {
    expect(escapeLike('عيادة لومن')).toBe('عيادة لومن');
  });
});
