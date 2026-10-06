import {
  businessMinutesBetween,
  describeNextOpening,
  isOpenAt,
} from './business-hours';

const DHAKA = 'Asia/Dhaka'; // UTC+6, no DST — the reference tenant's zone.
const NEW_YORK = 'America/New_York'; // has DST, which is the point of using it.

const NINE_TO_FIVE = {
  mon: { open: '09:00', close: '17:00' },
  tue: { open: '09:00', close: '17:00' },
  wed: { open: '09:00', close: '17:00' },
  thu: { open: '09:00', close: '17:00' },
  fri: { open: '09:00', close: '17:00' },
};

describe('isOpenAt()', () => {
  it('treats no configuration as always open — the behaviour every tenant had before hours existed', () => {
    expect(isOpenAt(null, null, new Date('2026-08-18T03:00:00Z'))).toBe(true);
    expect(isOpenAt({}, DHAKA, new Date('2026-08-18T03:00:00Z'))).toBe(true);
    expect(isOpenAt(NINE_TO_FIVE, null, new Date('2026-08-18T03:00:00Z'))).toBe(
      true,
    );
  });

  it("reads the clock in the tenant's zone, not the server's", () => {
    // 06:00 UTC on a Tuesday is 12:00 in Dhaka (open) and 02:00 in New York.
    const at = new Date('2026-08-18T06:00:00Z');
    expect(isOpenAt(NINE_TO_FIVE, DHAKA, at)).toBe(true);
    expect(isOpenAt(NINE_TO_FIVE, NEW_YORK, at)).toBe(false);
  });

  it('is closed on a day with no entry', () => {
    // 2026-08-16 is a Sunday.
    expect(
      isOpenAt(NINE_TO_FIVE, DHAKA, new Date('2026-08-16T06:00:00Z')),
    ).toBe(false);
  });

  it('is open at the opening minute and closed at the closing minute', () => {
    // Tuesday 09:00 and 17:00 Dhaka time.
    expect(
      isOpenAt(NINE_TO_FIVE, DHAKA, new Date('2026-08-18T03:00:00Z')),
    ).toBe(true);
    expect(
      isOpenAt(NINE_TO_FIVE, DHAKA, new Date('2026-08-18T11:00:00Z')),
    ).toBe(false);
  });

  it('treats a close at or before open as closed rather than guessing an overnight shift', () => {
    const suspicious = { tue: { open: '22:00', close: '06:00' } };
    expect(isOpenAt(suspicious, DHAKA, new Date('2026-08-18T18:00:00Z'))).toBe(
      false,
    );
  });

  it('falls back to open on an unknown timezone instead of taking the caller down', () => {
    expect(
      isOpenAt(NINE_TO_FIVE, 'Mars/Olympus', new Date('2026-08-18T06:00:00Z')),
    ).toBe(true);
  });
});

describe('businessMinutesBetween()', () => {
  it('counts wall-clock minutes when no hours are configured', () => {
    expect(
      businessMinutesBetween(
        null,
        null,
        new Date('2026-08-18T00:00:00Z'),
        new Date('2026-08-18T01:00:00Z'),
      ),
    ).toBe(60);
  });

  it('does not accrue overnight — the whole reason a 3am escalation is not "stuck" by 3:20am', () => {
    // Tuesday 21:00 Dhaka -> Tuesday 23:00 Dhaka, entirely after closing.
    expect(
      businessMinutesBetween(
        NINE_TO_FIVE,
        DHAKA,
        new Date('2026-08-18T15:00:00Z'),
        new Date('2026-08-18T17:00:00Z'),
      ),
    ).toBe(0);
  });

  it('counts only the open part of a window that straddles closing time', () => {
    // Tuesday 16:30 -> 17:30 Dhaka: 30 minutes before close, 30 after.
    expect(
      businessMinutesBetween(
        NINE_TO_FIVE,
        DHAKA,
        new Date('2026-08-18T10:30:00Z'),
        new Date('2026-08-18T11:30:00Z'),
      ),
    ).toBe(30);
  });

  it('bridges a closed night: minutes before closing plus minutes after opening', () => {
    // Tuesday 16:50 -> Wednesday 09:10 Dhaka = 10 + 10.
    expect(
      businessMinutesBetween(
        NINE_TO_FIVE,
        DHAKA,
        new Date('2026-08-18T10:50:00Z'),
        new Date('2026-08-19T03:10:00Z'),
      ),
    ).toBe(20);
  });

  it('falls back to wall-clock when every configured day is closed, so a genuinely stuck ticket can still be flagged', () => {
    expect(
      businessMinutesBetween(
        { mon: { open: '09:00', close: '09:00' } },
        DHAKA,
        new Date('2026-08-18T00:00:00Z'),
        new Date('2026-08-18T00:30:00Z'),
      ),
    ).toBe(30);
  });

  it('never returns a negative span', () => {
    expect(
      businessMinutesBetween(
        NINE_TO_FIVE,
        DHAKA,
        new Date('2026-08-18T10:00:00Z'),
        new Date('2026-08-18T09:00:00Z'),
      ),
    ).toBe(0);
  });
});

describe('describeNextOpening()', () => {
  it('summarises the configured days for the prompt', () => {
    expect(describeNextOpening(NINE_TO_FIVE, DHAKA)).toBe(
      'mon 09:00-17:00, tue 09:00-17:00, wed 09:00-17:00, thu 09:00-17:00, fri 09:00-17:00 (Asia/Dhaka)',
    );
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeNextOpening(null, DHAKA)).toBeNull();
    expect(describeNextOpening({}, DHAKA)).toBeNull();
  });
});
