// Product shell (ConversationModule): the opaque keyset cursor shared by
// both inbox listings. Keyset, not OFFSET — an inbox is sorted by a column
// that keeps moving (a new inbound message reorders the list), and OFFSET
// paging over a moving list silently skips and repeats rows. The tiebreaker
// id is part of the cursor because timestamps collide (a T10-coalesced
// burst writes several messages within the same millisecond).
export interface InboxCursor {
  /** Sort-column value of the last row of the previous page. */
  at: Date;
  /** That row's id — the tiebreaker for equal timestamps. */
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`).toString(
    'base64url',
  );
}

/** Returns null for anything malformed — a hand-edited cursor is client error, never a 500 and never a silently-ignored filter. */
export function decodeCursor(raw: string): InboxCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf('|');
  if (separator === -1) return null;

  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || !UUID_PATTERN.test(id)) return null;

  return { at, id };
}
