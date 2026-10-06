import {
  availableSlots,
  checkSlot,
  windowsFor,
  type Interval,
  type SlotRules,
} from './booking-slots';

const THU = { year: 2026, month: 10, day: 8 }; // a Thursday
const FRI = { year: 2026, month: 10, day: 9 };

const RULES: SlotRules = {
  timeZone: 'Asia/Riyadh',
  weeklyHours: {
    thu: [
      { open: '09:00', close: '12:00' },
      { open: '16:00', close: '18:00' },
    ],
  },
  durationMinutes: 45,
  bufferMinutes: 15,
  slotIntervalMinutes: 30,
  minNoticeMinutes: 60,
};

/** Riyadh is UTC+3 all year. */
const at = (hhmm: string) => Date.parse(`2026-10-08T${hhmm}:00+03:00`);
const NOW = Date.parse('2026-10-07T12:00:00Z');

describe('windowsFor', () => {
  it('drops inverted and malformed windows and sorts the rest', () => {
    expect(
      windowsFor(
        {
          mon: [
            { open: '16:00', close: '18:00' },
            { open: '22:00', close: '06:00' },
            { open: 'nine', close: '10:00' },
            { open: '09:00', close: '12:00' },
          ],
        },
        'mon',
      ),
    ).toEqual([
      { open: 540, close: 720 },
      { open: 960, close: 1080 },
    ]);
  });
});

describe('availableSlots', () => {
  it('offers grid starts inside each window where the whole appointment fits', () => {
    const slots = availableSlots(THU, RULES, [], NOW).map((s) => s.localTime);
    // 09:00..11:00 (11:15 would end 12:00 — fits; grid is 30 min so 11:00 is last), 16:00..17:00
    expect(slots).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '16:00',
      '16:30',
      '17:00',
    ]);
  });

  it('returns nothing on a closed day', () => {
    expect(availableSlots(FRI, RULES, [], NOW)).toEqual([]);
  });

  it('removes slots that would overlap a booking plus its buffer', () => {
    // An existing 10:00-10:45 appointment with a 15 min buffer blocks 10:00-11:00.
    const blocked: Interval[] = [{ startMs: at('10:00'), endMs: at('11:00') }];
    const slots = availableSlots(THU, RULES, blocked, NOW).map(
      (s) => s.localTime,
    );
    // 09:30 would run 09:30-10:15 (+buffer to 10:30): overlaps. 09:00 ends 09:45+15 = 10:00: free (half-open).
    expect(slots).toEqual(['09:00', '11:00', '16:00', '16:30', '17:00']);
  });

  it('honours the minimum notice', () => {
    const now = at('09:20'); // 60 min notice → nothing before 10:20
    const slots = availableSlots(THU, RULES, [], now).map((s) => s.localTime);
    expect(slots[0]).toBe('10:30');
  });

  it('reports instants in UTC', () => {
    const [first] = availableSlots(THU, RULES, [], NOW);
    expect(new Date(first.startMs).toISOString()).toBe(
      '2026-10-08T06:00:00.000Z',
    );
    expect(new Date(first.endMs).toISOString()).toBe(
      '2026-10-08T06:45:00.000Z',
    );
  });

  it('never offers a slot for zero or negative durations', () => {
    expect(
      availableSlots(THU, { ...RULES, durationMinutes: 0 }, [], NOW),
    ).toEqual([]);
  });
});

describe('checkSlot', () => {
  it('accepts a free grid time', () => {
    const r = checkSlot(THU, 16 * 60 + 30, RULES, [], NOW);
    expect(r).toMatchObject({ ok: true, slot: { localTime: '16:30' } });
  });

  it.each([
    ['outside every window', 13 * 60, 'closed'],
    ['would run past closing', 17 * 60 + 30, 'closed'],
    ['off the 30-minute grid', 9 * 60 + 10, 'invalid_time'],
  ])('refuses a time %s', (_label, minutes, reason) => {
    expect(checkSlot(THU, minutes, RULES, [], NOW)).toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses a taken time', () => {
    const blocked: Interval[] = [{ startMs: at('16:00'), endMs: at('17:00') }];
    expect(checkSlot(THU, 16 * 60 + 30, RULES, blocked, NOW)).toEqual({
      ok: false,
      reason: 'taken',
    });
  });

  it('refuses a time inside the notice period', () => {
    expect(checkSlot(THU, 9 * 60, RULES, [], at('08:30'))).toEqual({
      ok: false,
      reason: 'too_soon',
    });
  });
});
