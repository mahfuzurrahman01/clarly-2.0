import {
  buildBookingConfirmation,
  findBookedAppointments,
} from './booking-confirmation';

const CONFIRMED = JSON.stringify({
  status: 'confirmed',
  bookingReference: 'BK-7Q2M9X',
  service: 'Teeth Cleaning',
  date: '2026-10-08',
  weekday: 'thu',
  time: '16:30',
  durationMinutes: 45,
  location: 'online',
  meetingUrl: 'https://meet.google.com/abc',
  duplicate: false,
  customerMessage: 'appointment_confirmed',
});

describe('booking confirmation fallback', () => {
  it('ignores order results, refusals and other tool output', () => {
    expect(
      findBookedAppointments([
        JSON.stringify({ status: 'confirmed', orderReference: 'ORD-1' }),
        JSON.stringify({
          status: 'refused',
          customerMessage: 'time_no_longer_available',
        }),
        'not json',
      ]),
    ).toEqual([]);
  });

  it('dedups a booking re-read by a retried call', () => {
    expect(findBookedAppointments([CONFIRMED, CONFIRMED])).toHaveLength(1);
  });

  it('writes English with the meeting link', () => {
    expect(
      buildBookingConfirmation([CONFIRMED], 'can I book tomorrow 4:30?'),
    ).toBe(
      'Your Teeth Cleaning appointment is confirmed for 2026-10-08 at 16:30. Booking reference: BK-7Q2M9X.\nMeeting link: https://meet.google.com/abc',
    );
  });

  it('writes Arabic for an Arabic message, and never says a request is confirmed', () => {
    const requested = CONFIRMED.replace('"confirmed"', '"requested"');
    const text = buildBookingConfirmation([requested], 'أبي موعد بكرة') ?? '';
    expect(text).toContain('بانتظار تأكيد فريقنا');
    expect(text).not.toContain('تم تأكيد');
  });

  it('returns null when nothing was booked', () => {
    expect(buildBookingConfirmation([], 'hi')).toBeNull();
  });
});
