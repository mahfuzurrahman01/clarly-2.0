// Clarly 2.0 S2: request/response contracts for /bookings/*.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  BOOKING_LOCATIONS,
  BOOKING_MODES,
  BOOKING_STATUSES,
  BOOKING_WEEKDAYS,
  CALENDAR_CONNECTION_STATUSES,
  CALENDAR_SYNC_STATUSES,
} from '../persistence/drizzle/schema';
import { isValidTimeZone, parseClock, parseLocalDate } from './booking-time';

const clock = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'HH:MM')
  .refine((v) => parseClock(v) !== null, 'Not a clock time');

const openingWindowSchema = z
  .object({ open: clock, close: clock })
  .refine((w) => (parseClock(w.close) ?? 0) > (parseClock(w.open) ?? 0), {
    message: 'close must be after open (overnight windows are not supported)',
  });

/** Max three windows a day, non-overlapping. */
const dayWindowsSchema = z
  .array(openingWindowSchema)
  .max(3)
  .refine(
    (windows) => {
      const sorted = [...windows].sort(
        (a, b) => (parseClock(a.open) ?? 0) - (parseClock(b.open) ?? 0),
      );
      return sorted.every(
        (w, i) =>
          i === 0 ||
          (parseClock(w.open) ?? 0) >= (parseClock(sorted[i - 1].close) ?? 0),
      );
    },
    { message: 'Windows on one day must not overlap' },
  );

export const weeklyHoursSchema = z
  .object(
    Object.fromEntries(
      BOOKING_WEEKDAYS.map((d) => [d, dayWindowsSchema.optional()]),
    ) as Record<
      (typeof BOOKING_WEEKDAYS)[number],
      z.ZodOptional<typeof dayWindowsSchema>
    >,
  )
  .strict();

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Unknown IANA time zone, e.g. Asia/Riyadh');

// --- settings --------------------------------------------------------------

export const bookingSettingsSchema = z.object({
  mode: z.enum(BOOKING_MODES),
  timeZone: z.string(),
  weeklyHours: z.record(
    z.array(z.object({ open: z.string(), close: z.string() })),
  ),
  slotIntervalMinutes: z.number().int(),
  minNoticeMinutes: z.number().int(),
  maxDaysAhead: z.number().int(),
});
export type BookingSettingsRecord = z.infer<typeof bookingSettingsSchema>;
export class BookingSettingsDto extends createZodDto(bookingSettingsSchema) {}

export const updateBookingSettingsBodySchema = z
  .object({
    mode: z.enum(BOOKING_MODES).optional(),
    timeZone: timeZoneSchema.optional(),
    weeklyHours: weeklyHoursSchema.optional(),
    slotIntervalMinutes: z.number().int().min(5).max(240).optional(),
    minNoticeMinutes: z.number().int().min(0).max(10080).optional(),
    maxDaysAhead: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export type UpdateBookingSettingsBody = z.infer<
  typeof updateBookingSettingsBodySchema
>;
export class UpdateBookingSettingsBodyDto extends createZodDto(
  updateBookingSettingsBodySchema,
) {}

// --- services --------------------------------------------------------------

export const bookingServiceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  bufferMinutes: z.number().int(),
  price: z
    .string()
    .nullable()
    .describe('Decimal string, e.g. "250.00"; null = price on request.'),
  currency: z.string().nullable(),
  location: z.enum(BOOKING_LOCATIONS),
  active: z.boolean(),
});
export type BookingServiceRecord = z.infer<typeof bookingServiceSchema>;
export class BookingServiceDto extends createZodDto(bookingServiceSchema) {}
export class BookingServiceListDto extends createZodDto(
  z.array(bookingServiceSchema),
) {}

const priceInput = z
  .union([z.number().nonnegative().max(9_999_999_999), z.null()])
  .transform((v) => (v === null ? null : v.toFixed(2)));

const currencyInput = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
);

export const createBookingServiceBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    durationMinutes: z.number().int().min(5).max(480),
    bufferMinutes: z.number().int().min(0).max(240).optional(),
    price: priceInput.optional(),
    currency: currencyInput.optional(),
    location: z.enum(BOOKING_LOCATIONS).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type CreateBookingServiceBody = z.infer<
  typeof createBookingServiceBodySchema
>;
export class CreateBookingServiceBodyDto extends createZodDto(
  createBookingServiceBodySchema,
) {}

export const updateBookingServiceBodySchema = createBookingServiceBodySchema
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field');
export type UpdateBookingServiceBody = z.infer<
  typeof updateBookingServiceBodySchema
>;
export class UpdateBookingServiceBodyDto extends createZodDto(
  updateBookingServiceBodySchema,
) {}

// --- bookings --------------------------------------------------------------

export const bookingSchema = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  status: z.enum(BOOKING_STATUSES),
  serviceId: z.string().uuid(),
  serviceName: z.string(),
  location: z.enum(BOOKING_LOCATIONS),
  startsAt: isoTimestamp(),
  endsAt: isoTimestamp(),
  timeZone: z.string(),
  customerId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  customerName: z.string(),
  customerPhone: z.string().nullable(),
  customerEmail: z.string().nullable(),
  notes: z.string().nullable(),
  meetingUrl: z.string().nullable(),
  calendarSyncStatus: z.enum(CALENDAR_SYNC_STATUSES),
  calendarSyncError: z.string().nullable(),
  source: z.enum(['agent', 'console']),
  confirmedAt: isoTimestamp().nullable(),
  cancelledAt: isoTimestamp().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: isoTimestamp(),
});
export type BookingRecord = z.infer<typeof bookingSchema>;
export class BookingDto extends createZodDto(bookingSchema) {}

export const bookingPageSchema = z.object({
  items: z.array(bookingSchema),
  nextCursor: z.string().nullable(),
});
export class BookingPageDto extends createZodDto(bookingPageSchema) {}

export const listBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  from: z.coerce
    .date()
    .optional()
    .describe('Only bookings starting at or after this instant.'),
  to: z.coerce
    .date()
    .optional()
    .describe('Only bookings starting before this instant.'),
  order: z
    .enum(['asc', 'desc'])
    .default('asc')
    .describe('By start time. `asc` is an agenda (upcoming); `desc` is history.'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

const localDate = z
  .string()
  .refine((v) => parseLocalDate(v) !== null, 'YYYY-MM-DD, a real date');

export const createBookingBodySchema = z
  .object({
    serviceId: z.string().uuid(),
    date: localDate.describe('Local date in the workspace time zone.'),
    time: clock.describe('Local start time HH:MM in the workspace time zone.'),
    customerName: z.string().trim().min(1).max(200),
    customerPhone: z.string().trim().min(5).max(30).nullable().optional(),
    customerEmail: z.string().trim().email().max(200).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    status: z
      .enum(['requested', 'confirmed'])
      .optional()
      .describe('Console bookings default to confirmed.'),
  })
  .strict();
export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;
export class CreateBookingBodyDto extends createZodDto(
  createBookingBodySchema,
) {}

export const cancelBookingBodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type CancelBookingBody = z.infer<typeof cancelBookingBodySchema>;
export class CancelBookingBodyDto extends createZodDto(
  cancelBookingBodySchema,
) {}

export const availabilityQuerySchema = z.object({
  serviceId: z.string().uuid(),
  date: localDate,
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const availabilitySchema = z.object({
  date: z.string(),
  timeZone: z.string(),
  slots: z.array(
    z.object({
      time: z.string().describe('Local HH:MM.'),
      startsAt: isoTimestamp(),
      endsAt: isoTimestamp(),
    }),
  ),
  calendarChecked: z
    .boolean()
    .describe(
      'False when a connected calendar could not be read; the slots then only reflect bookings in Clarly.',
    ),
});
export type AvailabilityRecord = z.infer<typeof availabilitySchema>;
export class AvailabilityDto extends createZodDto(availabilitySchema) {}

// --- calendar --------------------------------------------------------------

export const calendarStatusSchema = z.object({
  configured: z
    .boolean()
    .describe('Whether the platform has Google OAuth credentials at all.'),
  connection: z
    .object({
      provider: z.literal('google'),
      accountEmail: z.string().nullable(),
      status: z.enum(CALENDAR_CONNECTION_STATUSES),
      lastError: z.string().nullable(),
      connectedAt: isoTimestamp(),
    })
    .nullable(),
});
export type CalendarStatusRecord = z.infer<typeof calendarStatusSchema>;
export class CalendarStatusDto extends createZodDto(calendarStatusSchema) {}

export const calendarConnectUrlSchema = z.object({ url: z.string().url() });
export class CalendarConnectUrlDto extends createZodDto(
  calendarConnectUrlSchema,
) {}
