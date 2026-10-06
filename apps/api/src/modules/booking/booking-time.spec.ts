import {
  addDays,
  isValidTimeZone,
  localToday,
  parseClock,
  parseLocalDate,
  wallTimeOf,
  weekdayIndex,
  zonedWallTimeToInstant,
} from './booking-time';

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

describe('parseLocalDate', () => {
  it('accepts a real date', () => {
    expect(parseLocalDate('2026-10-08')).toEqual({
      year: 2026,
      month: 10,
      day: 8,
    });
  });
  it.each(['2026-02-30', '2026-13-01', '26-10-08', '2026-10-8', 'tomorrow'])(
    'rejects %s',
    (value) => expect(parseLocalDate(value)).toBeNull(),
  );
});

describe('parseClock', () => {
  it('parses HH:MM', () => expect(parseClock('09:30')).toBe(570));
  it.each(['24:00', '9:7', '12:60', 'noon'])('rejects %s', (v) =>
    expect(parseClock(v)).toBeNull(),
  );
});

describe('weekdayIndex / addDays', () => {
  it('2026-10-08 is a Thursday', () => {
    expect(weekdayIndex({ year: 2026, month: 10, day: 8 })).toBe(4);
  });
  it('rolls over month and year ends', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });
});

describe('zonedWallTimeToInstant', () => {
  it('Riyadh (UTC+3, no DST)', () => {
    expect(
      iso(
        zonedWallTimeToInstant(
          { year: 2026, month: 10, day: 8 },
          15 * 60 + 30,
          'Asia/Riyadh',
        ),
      ),
    ).toBe('2026-10-08T12:30:00.000Z');
  });

  it('Dhaka (UTC+6) — the zone Autologic hard-coded', () => {
    expect(
      iso(
        zonedWallTimeToInstant(
          { year: 2026, month: 10, day: 8 },
          9 * 60,
          'Asia/Dhaka',
        ),
      ),
    ).toBe('2026-10-08T03:00:00.000Z');
  });

  it('a local time just after midnight that is the previous UTC day', () => {
    expect(
      iso(
        zonedWallTimeToInstant(
          { year: 2026, month: 10, day: 8 },
          30,
          'Asia/Dubai',
        ),
      ),
    ).toBe('2026-10-07T20:30:00.000Z');
  });

  it('London summer time (UTC+1) and winter time (UTC+0)', () => {
    expect(
      iso(
        zonedWallTimeToInstant(
          { year: 2026, month: 7, day: 1 },
          10 * 60,
          'Europe/London',
        ),
      ),
    ).toBe('2026-07-01T09:00:00.000Z');
    expect(
      iso(
        zonedWallTimeToInstant(
          { year: 2026, month: 12, day: 1 },
          10 * 60,
          'Europe/London',
        ),
      ),
    ).toBe('2026-12-01T10:00:00.000Z');
  });

  // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 -> 03:00).
  it('returns null for a wall time skipped by DST', () => {
    expect(
      zonedWallTimeToInstant(
        { year: 2026, month: 3, day: 8 },
        2 * 60 + 30,
        'America/New_York',
      ),
    ).toBeNull();
  });

  // 2026-11-01 01:30 happens twice in New York; the first (EDT) is chosen.
  it('resolves an ambiguous fall-back time to its first occurrence', () => {
    expect(
      iso(
        zonedWallTimeToInstant(
          { year: 2026, month: 11, day: 1 },
          90,
          'America/New_York',
        ),
      ),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  it('round-trips through wallTimeOf', () => {
    const ms = zonedWallTimeToInstant(
      { year: 2026, month: 10, day: 8 },
      17 * 60 + 45,
      'Asia/Kuwait',
    );
    expect(ms).not.toBeNull();
    expect(wallTimeOf(ms as number, 'Asia/Kuwait')).toEqual({
      year: 2026,
      month: 10,
      day: 8,
      minutes: 17 * 60 + 45,
    });
  });
});

describe('localToday / isValidTimeZone', () => {
  it('uses the zone, not UTC, to decide the date', () => {
    // 22:00 UTC on Oct 7 is already Oct 8 in Riyadh.
    expect(
      localToday(Date.parse('2026-10-07T22:00:00Z'), 'Asia/Riyadh'),
    ).toEqual({
      year: 2026,
      month: 10,
      day: 8,
    });
  });
  it('knows real zones and rejects made-up ones', () => {
    expect(isValidTimeZone('Asia/Riyadh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
