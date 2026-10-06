// Clarly 2.0 S2: what `check_availability` and `book_appointment` actually do.
//
// Like CreateOrderExecutor, results carry MACHINE TOKENS in `customerMessage`
// rather than prose, so wording stays in the customer's own language and
// dialect (decided by the model under L0), and refusals are structured
// results the model can act on rather than thrown errors that burn the loop.
import { Injectable } from '@nestjs/common';
import { ToolScopeViolation } from '@repo/errors';
import { createHash } from 'node:crypto';
import { Clock } from '../core';
import {
  isFabricatedPhone,
  isPlaceholderValue,
} from '../order/customer-detail-placeholders';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';
import { BookingCatalogService, matchService } from './booking-catalog.service';
import {
  BookingServiceNotFoundError,
  BookingSlotError,
  BookingsDisabledError,
} from './booking-errors';
import { BookingSettingsService } from './booking-settings.service';
import { BOOKING_WEEKDAYS } from './booking-slots';
import {
  formatLocalDate,
  localToday,
  parseClock,
  parseLocalDate,
  wallTimeOf,
  weekdayIndex,
  type LocalDate,
} from './booking-time';
import type {
  BookAppointmentInput,
  CheckAvailabilityInput,
} from './booking-tools';
import { BookingService } from './booking.service';

/** Times listed per day; enough to offer a choice without flooding the context. */
const MAX_TIMES_PER_DAY = 12;
const MAX_TIMES_PER_UPCOMING_DAY = 4;

const weekdayOf = (d: LocalDate) => BOOKING_WEEKDAYS[weekdayIndex(d)];

interface ServiceSummary {
  name: string;
  durationMinutes: number;
  price: string | null;
  currency: string | null;
  location: string;
}

export type CheckAvailabilityResult =
  | {
      status: 'ok';
      service: ServiceSummary;
      timeZone: string;
      today: string;
      todayWeekday: string;
      /** Present when a date was asked for. */
      date?: string;
      weekday?: string;
      times?: string[];
      /** Present when no date was asked for: the next days with free times. */
      days?: Array<{ date: string; weekday: string; times: string[] }>;
      /** False when a connected calendar could not be read: say the time still needs the team's confirmation. */
      calendarChecked: boolean;
    }
  | {
      status: 'day_unavailable';
      reason: 'closed_or_full' | 'out_of_range' | 'invalid_date';
      service: ServiceSummary;
      today: string;
      todayWeekday: string;
      date: string;
      otherDays: Array<{ date: string; weekday: string; times: string[] }>;
    }
  | {
      status: 'no_such_service';
      services: string[];
      customerMessage: 'ask_which_service';
    }
  | {
      status: 'bookings_unavailable';
      customerMessage: 'bookings_not_offered_escalate';
    };

export type BookAppointmentResult =
  | {
      status: 'confirmed' | 'requested';
      bookingReference: string;
      service: string;
      date: string;
      weekday: string;
      time: string;
      durationMinutes: number;
      location: string;
      meetingUrl: string | null;
      duplicate: boolean;
      customerMessage:
        'appointment_confirmed' | 'appointment_requested_awaiting_confirmation';
    }
  | {
      status: 'refused';
      reason:
        | 'missing_customer_name'
        | 'unverified_contact'
        | 'no_such_service'
        | 'slot_unavailable'
        | 'bookings_disabled';
      detail?: string;
      alternatives?: string[];
      customerMessage:
        | 'ask_customer_for_name'
        | 'ask_customer_for_contact'
        | 'ask_which_service'
        | 'time_no_longer_available'
        | 'bookings_not_offered_escalate';
    };

function summary(service: {
  name: string;
  durationMinutes: number;
  price: string | null;
  currency: string | null;
  location: string;
}): ServiceSummary {
  return {
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    currency: service.currency,
    location: service.location,
  };
}

/** Digits of a phone number, Arabic-Indic and Persian digits folded to ASCII. */
export function phoneDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

/**
 * Whether a contact value the model passed is one the customer actually
 * wrote. Phone: the last 7 digits appear in the customer's text. Email: the
 * address appears, case-insensitively. Skipped (true) when the caller gave
 * no customer text, same as create_order's provenance check.
 */
export function isGroundedContact(
  value: string,
  kind: 'phone' | 'email',
  customerText: string | undefined,
): boolean {
  if (customerText === undefined) return true;
  if (kind === 'email') {
    return customerText.toLowerCase().includes(value.trim().toLowerCase());
  }
  const digits = phoneDigits(value);
  if (digits.length < 7) return false;
  return phoneDigits(customerText).includes(digits.slice(-7));
}

@Injectable()
export class CheckAvailabilityExecutor {
  constructor(
    private readonly settings: BookingSettingsService,
    private readonly catalog: BookingCatalogService,
    private readonly bookingService: BookingService,
    private readonly clock: Clock,
  ) {}

  async execute(
    ctx: ToolExecutionContext,
    args: CheckAvailabilityInput,
  ): Promise<CheckAvailabilityResult> {
    const settings = await this.settings.get(ctx.tenantId);
    if (settings.mode === 'disabled') {
      return {
        status: 'bookings_unavailable',
        customerMessage: 'bookings_not_offered_escalate',
      };
    }
    const services = await this.catalog.list(ctx.tenantId, {
      activeOnly: true,
    });
    const service = matchService(services, args.service);
    if (!service) {
      return {
        status: 'no_such_service',
        services: services.map((s) => s.name),
        customerMessage: 'ask_which_service',
      };
    }

    const nowMs = this.clock.now().getTime();
    const today = localToday(nowMs, settings.timeZone);
    const base = {
      service: summary(service),
      today: formatLocalDate(today),
      todayWeekday: weekdayOf(today),
    };

    const upcoming = async () => {
      const result = await this.bookingService.upcomingAvailability(
        ctx.tenantId,
        settings,
        service,
        nowMs,
      );
      return {
        calendarChecked: result.calendarChecked,
        days: result.days.map((d) => ({
          date: formatLocalDate(d.date),
          weekday: weekdayOf(d.date),
          times: d.slots
            .slice(0, MAX_TIMES_PER_UPCOMING_DAY)
            .map((s) => s.localTime),
        })),
      };
    };

    if (!args.date) {
      const { days, calendarChecked } = await upcoming();
      return {
        status: 'ok',
        ...base,
        timeZone: settings.timeZone,
        days,
        calendarChecked,
      };
    }

    const date = parseLocalDate(args.date);
    if (!date || !this.bookingService.inBookingRange(settings, date, nowMs)) {
      return {
        status: 'day_unavailable',
        reason: date ? 'out_of_range' : 'invalid_date',
        ...base,
        date: args.date,
        otherDays: (await upcoming()).days,
      };
    }

    const day = await this.bookingService.dayAvailability(
      ctx.tenantId,
      settings,
      service,
      date,
      nowMs,
    );
    if (day.slots.length === 0) {
      return {
        status: 'day_unavailable',
        reason: 'closed_or_full',
        ...base,
        date: args.date,
        otherDays: (await upcoming()).days,
      };
    }
    return {
      status: 'ok',
      ...base,
      timeZone: settings.timeZone,
      date: args.date,
      weekday: weekdayOf(date),
      times: day.slots.slice(0, MAX_TIMES_PER_DAY).map((s) => s.localTime),
      calendarChecked: day.calendarChecked,
    };
  }
}

@Injectable()
export class BookAppointmentExecutor {
  constructor(
    private readonly catalog: BookingCatalogService,
    private readonly settings: BookingSettingsService,
    private readonly bookingService: BookingService,
    private readonly clock: Clock,
  ) {}

  async execute(
    ctx: ToolExecutionContext,
    args: BookAppointmentInput,
  ): Promise<BookAppointmentResult> {
    // Customer-scoped side effect: never from a non-conversational caller.
    if (!ctx.customerId) throw new ToolScopeViolation();

    if (isPlaceholderValue(args.customerName)) {
      return {
        status: 'refused',
        reason: 'missing_customer_name',
        detail:
          'No appointment was booked. The name is missing or a placeholder. Ask the customer for their name, then call book_appointment again.',
        customerMessage: 'ask_customer_for_name',
      };
    }
    if (
      (args.customerPhone &&
        (isFabricatedPhone(args.customerPhone) ||
          !isGroundedContact(args.customerPhone, 'phone', ctx.customerText))) ||
      (args.customerEmail &&
        !isGroundedContact(args.customerEmail, 'email', ctx.customerText))
    ) {
      return {
        status: 'refused',
        reason: 'unverified_contact',
        detail:
          'No appointment was booked. A phone number or email was passed that the customer did not write. Leave it out, or ask the customer for it.',
        customerMessage: 'ask_customer_for_contact',
      };
    }

    const services = await this.catalog.list(ctx.tenantId, {
      activeOnly: true,
    });
    const service = matchService(services, args.service);
    const date = parseLocalDate(args.date);
    const minutes = parseClock(args.time);
    if (!service) {
      return {
        status: 'refused',
        reason: 'no_such_service',
        detail: `Services offered: ${services.map((s) => s.name).join(', ')}`,
        customerMessage: 'ask_which_service',
      };
    }
    if (!date || minutes === null) {
      return this.slotRefusal(ctx, service, date, 'invalid_time');
    }

    const idempotencyKey = ctx.turnId
      ? `agent:${createHash('sha256')
          .update(
            [
              ctx.tenantId,
              ctx.conversationId ?? '',
              ctx.turnId,
              service.id,
              args.date,
              args.time,
            ].join('|'),
          )
          .digest('hex')}`
      : `agent:${createHash('sha256').update(`${ctx.tenantId}|${Date.now()}|${Math.random()}`).digest('hex')}`;

    try {
      const { booking, duplicate } = await this.bookingService.create({
        tenantId: ctx.tenantId,
        serviceId: service.id,
        date,
        startMinutes: minutes,
        customerName: args.customerName,
        customerPhone: args.customerPhone ?? null,
        customerEmail: args.customerEmail ?? null,
        notes: args.notes ?? null,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        source: 'agent',
        createdBy: null,
        idempotencyKey,
        now: this.clock.now(),
      });
      const local = wallTimeOf(booking.startsAt.getTime(), booking.timeZone);
      const localDate: LocalDate = {
        year: local.year,
        month: local.month,
        day: local.day,
      };
      const confirmed = booking.status === 'confirmed';
      return {
        status: confirmed ? 'confirmed' : 'requested',
        bookingReference: booking.reference,
        service: booking.serviceName,
        date: formatLocalDate(localDate),
        weekday: weekdayOf(localDate),
        time: `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`,
        durationMinutes: Math.round(
          (booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000,
        ),
        location: booking.location,
        meetingUrl: booking.meetingUrl,
        duplicate,
        customerMessage: confirmed
          ? 'appointment_confirmed'
          : 'appointment_requested_awaiting_confirmation',
      };
    } catch (error) {
      if (error instanceof BookingsDisabledError) {
        return {
          status: 'refused',
          reason: 'bookings_disabled',
          customerMessage: 'bookings_not_offered_escalate',
        };
      }
      if (error instanceof BookingServiceNotFoundError) {
        return {
          status: 'refused',
          reason: 'no_such_service',
          customerMessage: 'ask_which_service',
        };
      }
      if (error instanceof BookingSlotError) {
        return this.slotRefusal(ctx, service, date, error.reason);
      }
      throw error;
    }
  }

  /** A refusal that hands the model the day's remaining times, so it can offer one at once. */
  private async slotRefusal(
    ctx: ToolExecutionContext,
    service: Parameters<BookingService['dayAvailability']>[2],
    date: LocalDate | null,
    reason: string,
  ): Promise<BookAppointmentResult> {
    let alternatives: string[] = [];
    if (date) {
      try {
        const settings = await this.settings.get(ctx.tenantId);
        const day = await this.bookingService.dayAvailability(
          ctx.tenantId,
          settings,
          service,
          date,
          this.clock.now().getTime(),
        );
        alternatives = day.slots
          .slice(0, MAX_TIMES_PER_UPCOMING_DAY)
          .map((s) => s.localTime);
      } catch {
        alternatives = [];
      }
    }
    return {
      status: 'refused',
      reason: 'slot_unavailable',
      detail: `No appointment was booked (${reason}). Offer one of the alternatives for that day, or call check_availability for another day.`,
      alternatives,
      customerMessage: 'time_no_longer_available',
    };
  }
}
