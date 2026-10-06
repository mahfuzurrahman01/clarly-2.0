// Clarly 2.0 S2: the two agent tools for appointments.
//
// Replaces Autologic's "append a {type:'booking'} JSON object to your reply,
// with ISO start/end in Asia/Dhaka" contract (AUTOLOGIC_AUDIT #16, #17).
// Here the model passes what the customer said — a service, a local date, a
// local time — and code does the time zone, the availability and the write.
//
// Guidance lives in these descriptions, not in L0: they reach the model only
// for tenants that have bookings switched on, and they change without a
// PROMPT_VERSION bump (prompt-version.ts) because no prompt template moves.
import { z } from 'zod';
import type { ToolDefinition } from '../tool-execution/tool-definitions';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export const CheckAvailabilityInput = z.object({
  service: z.string().trim().min(1).max(120),
  date: z.string().regex(DATE).optional(),
});
export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilityInput>;

export const checkAvailabilityToolDefinition: ToolDefinition<CheckAvailabilityInput> =
  {
    name: 'check_availability',
    description:
      'List the appointment times still free for a service, in the business’s own time zone. Call it before offering or confirming any time, every time — never say a time is free from memory or from the conversation. Pass the service the customer asked for (its name as they said it, in any language). You do not know today’s date: leave `date` out to get the next days with free times plus `today` and each day’s weekday; pass `date` (YYYY-MM-DD) only once you can work it out from `today` and what the customer said ("tomorrow", "Thursday", "الخميس"). Offer a few of the listed times; never offer one that is not listed. If `status` is `no_such_service`, tell the customer which services exist (listed in the result). If `status` is `day_unavailable`, say that day is not available and offer the days that are.',
    zodSchema: CheckAvailabilityInput,
    jsonSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'The service the customer wants, as they named it',
        },
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description:
            'Optional. The day, YYYY-MM-DD, in the business’s time zone. Omit to see the next days with free times',
        },
      },
      required: ['service'],
      additionalProperties: false,
    },
  };

export const BookAppointmentInput = z.object({
  service: z.string().trim().min(1).max(120),
  date: z.string().regex(DATE),
  time: z.string().regex(TIME),
  customerName: z.string().trim().min(1).max(200),
  customerPhone: z.string().trim().min(5).max(30).optional(),
  customerEmail: z.string().trim().email().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type BookAppointmentInput = z.infer<typeof BookAppointmentInput>;

export const bookAppointmentToolDefinition: ToolDefinition<BookAppointmentInput> =
  {
    name: 'book_appointment',
    description:
      'Book one appointment for the customer you are talking to. Call it only after (1) check_availability listed this exact date and time as free, (2) the customer chose that time, and (3) the customer themselves gave you their name. Never invent, guess or use a placeholder name ("Customer", "N/A"); if it is missing, ask for it and do not call this tool. Phone and email are optional: pass them only when the customer wrote them. Pass the date as YYYY-MM-DD and the time as HH:MM, exactly as check_availability listed it. Call it once per appointment; calling again for the same turn returns the same booking. Read `customerMessage` in the result and follow it exactly: `appointment_confirmed` means it is booked (give the reference, day and time, and the meeting link if there is one); `appointment_requested_awaiting_confirmation` means it is recorded and the team will confirm — never say it is confirmed; `time_no_longer_available` means pick again with check_availability; `ask_customer_for_name` means ask for their name first.',
    zodSchema: BookAppointmentInput,
    jsonSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'The service, as named in check_availability',
        },
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'YYYY-MM-DD, as listed by check_availability',
        },
        time: {
          type: 'string',
          pattern: '^\\d{2}:\\d{2}$',
          description: 'HH:MM start time, as listed by check_availability',
        },
        customerName: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'The name the customer gave. Ask if not given; never a placeholder',
        },
        customerPhone: {
          type: 'string',
          minLength: 5,
          maxLength: 30,
          description: 'Only if the customer wrote a phone number',
        },
        customerEmail: {
          type: 'string',
          maxLength: 200,
          description:
            'Only if the customer wrote an email address (the calendar invitation goes there)',
        },
        notes: {
          type: 'string',
          maxLength: 500,
          description: 'Anything the customer asked the business to know',
        },
      },
      required: ['service', 'date', 'time', 'customerName'],
      additionalProperties: false,
    },
  };

export const BOOKING_TOOL_DEFINITIONS = [
  checkAvailabilityToolDefinition,
  bookAppointmentToolDefinition,
] as const;
