// Clarly 2.0 S2: the booking twin of order-confirmation.ts.
//
// book_appointment is a side effect like create_order: once it has written a
// booking, the customer must hear about it even if the model runs out of time
// before calling `respond`, or they will ask again and get a second booking.
// When the loop gives up after a tool already wrote one, this builds the
// confirmation from the tool result itself (reference, service, day, time,
// meeting link), in Arabic or English after the customer's own script.
import { z } from 'zod';

const BookedSchema = z.object({
  status: z.enum(['confirmed', 'requested']),
  bookingReference: z.string().min(1),
  service: z.string().min(1),
  date: z.string().min(1),
  time: z.string().min(1),
  meetingUrl: z.string().nullable().optional(),
});

export type BookedAppointment = z.infer<typeof BookedSchema>;

const ARABIC_SCRIPT = /[؀-ۿ]/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Every booking a book_appointment call wrote (or re-read) this turn, one per reference. */
export function findBookedAppointments(
  toolEvidence: string[],
): BookedAppointment[] {
  const byRef = new Map<string, BookedAppointment>();
  for (const evidence of toolEvidence) {
    const parsed = BookedSchema.safeParse(parseJson(evidence));
    if (parsed.success && !byRef.has(parsed.data.bookingReference)) {
      byRef.set(parsed.data.bookingReference, parsed.data);
    }
  }
  return [...byRef.values()];
}

function describe(b: BookedAppointment, arabic: boolean): string {
  const lines: string[] = [];
  if (arabic) {
    lines.push(
      b.status === 'confirmed'
        ? `تم تأكيد موعدك (${b.service}) يوم ${b.date} الساعة ${b.time}. رقم الحجز: ${b.bookingReference}.`
        : `تم تسجيل طلب موعدك (${b.service}) يوم ${b.date} الساعة ${b.time}، وهو بانتظار تأكيد فريقنا. رقم الطلب: ${b.bookingReference}.`,
    );
    if (b.meetingUrl) lines.push(`رابط الاجتماع: ${b.meetingUrl}`);
  } else {
    lines.push(
      b.status === 'confirmed'
        ? `Your ${b.service} appointment is confirmed for ${b.date} at ${b.time}. Booking reference: ${b.bookingReference}.`
        : `Your ${b.service} appointment request for ${b.date} at ${b.time} is recorded and waiting for our team to confirm it. Reference: ${b.bookingReference}.`,
    );
    if (b.meetingUrl) lines.push(`Meeting link: ${b.meetingUrl}`);
  }
  return lines.join('\n');
}

export function buildBookingConfirmation(
  toolEvidence: string[],
  customerMessage: string,
): string | null {
  const booked = findBookedAppointments(toolEvidence);
  if (booked.length === 0) return null;
  const arabic = ARABIC_SCRIPT.test(customerMessage);
  return booked.map((b) => describe(b, arabic)).join('\n\n');
}
