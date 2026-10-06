// Clarly 2.0 S2: the appointment of record — availability, creation, and the
// status lifecycle. Both the agent tools and the console go through here.
//
// DOUBLE BOOKING. Creation runs under a per-tenant transaction-scoped
// advisory lock and re-reads the active bookings inside it, so two customers
// racing for 16:30 cannot both get it: the second sees the first and is
// refused `taken`. The calendar's free/busy is read BEFORE the transaction
// (a network call must not hold a database lock) and only ever removes
// options, so reading it early cannot create a double booking — at worst a
// busy block added in that second is missed, which the calendar invitation
// then shows the business.
//
// A TIME WE COULD NOT VERIFY IS NEVER CONFIRMED. In `auto` mode, if a
// calendar is connected but could not be read, the booking is recorded as
// `requested` for a person to confirm, never as `confirmed`.
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppLoggerService } from '../core';
import { NotificationService } from '../notifications/notification.service';
import { notificationContent } from '../notifications/notification-content';
import {
  ACTIVE_BOOKING_STATUSES,
  bookings,
  type BookingSource,
  type BookingStatus,
} from '../persistence/drizzle/schema';
import { isUniqueViolation } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BookingCatalogService } from './booking-catalog.service';
import {
  BookingNotFoundError,
  BookingServiceNotFoundError,
  BookingSlotError,
  BookingsDisabledError,
  InvalidBookingTransitionError,
} from './booking-errors';
import { generateBookingReference } from './booking-reference';
import {
  BookingSettingsService,
  type BookingSettings,
} from './booking-settings.service';
import {
  availableSlots,
  checkSlot,
  overlaps,
  type Interval,
  type Slot,
} from './booking-slots';
import {
  addDays,
  formatLocalDate,
  localToday,
  wallTimeOf,
  zonedWallTimeToInstant,
  type LocalDate,
} from './booking-time';
import type { BookingRecord, ListBookingsQuery } from './booking.dto';
import {
  CalendarAuthError,
  CalendarProvider,
} from './calendar/calendar-provider.port';
import {
  CalendarConnectionService,
  type ActiveCalendar,
} from './calendar/calendar-connection.service';

type BookingRow = typeof bookings.$inferSelect;
type ServiceRow = Awaited<ReturnType<BookingCatalogService['get']>> & {};

/** Longest an appointment (480) plus its buffer (240) can reach back. */
const LOOKBACK_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_DAYS = 14;

export function toBookingRecord(row: BookingRow): BookingRecord {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timeZone: row.timeZone,
    customerId: row.customerId,
    conversationId: row.conversationId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    notes: row.notes,
    meetingUrl: row.meetingUrl,
    calendarSyncStatus: row.calendarSyncStatus,
    calendarSyncError: row.calendarSyncError,
    source: row.source,
    confirmedAt: row.confirmedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt,
  };
}

/** Allowed status moves. `requested`/`confirmed` hold the slot; the rest are final. */
export const BOOKING_TRANSITIONS: Readonly<
  Record<BookingStatus, readonly BookingStatus[]>
> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'completed', 'no_show'],
  cancelled: [],
  completed: [],
  no_show: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export interface DayAvailability {
  date: LocalDate;
  slots: Slot[];
  calendarChecked: boolean;
}

export interface CreateBookingInput {
  tenantId: string;
  serviceId: string;
  date: LocalDate;
  startMinutes: number;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  notes: string | null;
  customerId: string | null;
  conversationId: string | null;
  source: BookingSource;
  createdBy: string | null;
  idempotencyKey: string;
  /** Console only: the status the person chose. The agent's status comes from the mode. */
  requestedStatus?: 'requested' | 'confirmed';
  now?: Date;
}

export interface CreateBookingResult {
  booking: BookingRecord;
  duplicate: boolean;
}

/** `<starts_at micros>|<uuid>` keyset cursor (ascending by start). */
function encodeCursor(startsAtMicros: string, id: string): string {
  return Buffer.from(`${startsAtMicros}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const [ts, id, ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  if (rest.length || !ts || !id) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(ts)) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { ts, id };
}
const STARTS_AT_MICROS = sql<string>`to_char(${bookings.startsAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class BookingService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly settingsService: BookingSettingsService,
    private readonly catalog: BookingCatalogService,
    private readonly calendars: CalendarConnectionService,
    private readonly calendarProvider: CalendarProvider,
    private readonly notifications: NotificationService,
    private readonly logger: AppLoggerService,
  ) {}

  // --- availability --------------------------------------------------------

  /** Instants bounding one local day (DST-safe: falls back to 01:00 if midnight is skipped). */
  private dayBounds(date: LocalDate, timeZone: string): Interval {
    const start =
      zonedWallTimeToInstant(date, 0, timeZone) ??
      zonedWallTimeToInstant(date, 60, timeZone) ??
      Date.UTC(date.year, date.month - 1, date.day);
    const next = addDays(date, 1);
    const end =
      zonedWallTimeToInstant(next, 0, timeZone) ??
      zonedWallTimeToInstant(next, 60, timeZone) ??
      start + DAY_MS;
    return { startMs: start, endMs: end };
  }

  /** Active bookings overlapping [fromMs, toMs), as blocked intervals including their buffer. */
  private async bookedIntervals(
    tenantId: string,
    fromMs: number,
    toMs: number,
    excludeId?: string,
  ): Promise<Interval[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: bookings.id,
            startsAt: bookings.startsAt,
            endsAt: bookings.endsAt,
            bufferMinutes: bookings.bufferMinutes,
          })
          .from(bookings)
          .where(
            and(
              eq(bookings.tenantId, tenantId),
              inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
              lt(bookings.startsAt, new Date(toMs)),
              gt(bookings.endsAt, new Date(fromMs - LOOKBACK_MS)),
            ),
          ),
      tenantId,
    );
    return rows
      .filter((r) => r.id !== excludeId)
      .map((r) => ({
        startMs: r.startsAt.getTime(),
        endMs: r.endsAt.getTime() + r.bufferMinutes * 60_000,
      }));
  }

  /**
   * Busy blocks from the connected calendar. `checked: false` when a calendar
   * is connected but could not be read; `connected: false` when there is none.
   */
  private async calendarBusy(
    tenantId: string,
    fromMs: number,
    toMs: number,
  ): Promise<{ intervals: Interval[]; checked: boolean; connected: boolean }> {
    let active: ActiveCalendar | null;
    try {
      active = await this.calendars.getActive(tenantId);
    } catch (error) {
      this.logger.warn(
        `could not read calendar connection for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
        BookingService.name,
      );
      return { intervals: [], checked: false, connected: true };
    }
    if (!active) {
      const connected = await this.calendars.hasConnection(tenantId);
      return { intervals: [], checked: !connected, connected };
    }
    try {
      const intervals = await this.calendarProvider.busyIntervals(
        active.credentials,
        active.calendarId,
        fromMs,
        toMs,
      );
      return { intervals, checked: true, connected: true };
    } catch (error) {
      if (error instanceof CalendarAuthError) {
        await this.calendars.markNeedsReconnect(tenantId, error.message);
      } else {
        this.logger.warn(
          `calendar free/busy failed for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
          BookingService.name,
        );
      }
      return { intervals: [], checked: false, connected: true };
    }
  }

  private rulesFor(
    settings: BookingSettings,
    service: NonNullable<ServiceRow>,
  ) {
    return {
      timeZone: settings.timeZone,
      weeklyHours: settings.weeklyHours,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      slotIntervalMinutes: settings.slotIntervalMinutes,
      minNoticeMinutes: settings.minNoticeMinutes,
    };
  }

  /** True when `date` is between today and today + maxDaysAhead in the tenant's zone. */
  inBookingRange(
    settings: BookingSettings,
    date: LocalDate,
    nowMs: number,
  ): boolean {
    const today = localToday(nowMs, settings.timeZone);
    const last = addDays(today, settings.maxDaysAhead);
    const key = (d: LocalDate) => d.year * 10_000 + d.month * 100 + d.day;
    return key(date) >= key(today) && key(date) <= key(last);
  }

  async dayAvailability(
    tenantId: string,
    settings: BookingSettings,
    service: NonNullable<ServiceRow>,
    date: LocalDate,
    nowMs: number,
  ): Promise<DayAvailability> {
    if (!this.inBookingRange(settings, date, nowMs)) {
      return { date, slots: [], calendarChecked: true };
    }
    const bounds = this.dayBounds(date, settings.timeZone);
    const [booked, calendar] = await Promise.all([
      this.bookedIntervals(tenantId, bounds.startMs, bounds.endMs),
      this.calendarBusy(tenantId, bounds.startMs, bounds.endMs),
    ]);
    const slots = availableSlots(
      date,
      this.rulesFor(settings, service),
      [...booked, ...calendar.intervals],
      nowMs,
    );
    return { date, slots, calendarChecked: calendar.checked };
  }

  /**
   * The next days (from today) that have at least one free slot, up to
   * `maxDays` of them, scanning at most two weeks or the booking horizon.
   * One calendar call covers the whole scan.
   */
  async upcomingAvailability(
    tenantId: string,
    settings: BookingSettings,
    service: NonNullable<ServiceRow>,
    nowMs: number,
    maxDays = 5,
  ): Promise<{ days: DayAvailability[]; calendarChecked: boolean }> {
    const today = localToday(nowMs, settings.timeZone);
    const scan = Math.min(settings.maxDaysAhead, MAX_SCAN_DAYS);
    const from = this.dayBounds(today, settings.timeZone).startMs;
    const to = this.dayBounds(addDays(today, scan), settings.timeZone).endMs;
    const [booked, calendar] = await Promise.all([
      this.bookedIntervals(tenantId, from, to),
      this.calendarBusy(tenantId, from, to),
    ]);
    const blocked = [...booked, ...calendar.intervals];
    const rules = this.rulesFor(settings, service);
    const days: DayAvailability[] = [];
    for (let i = 0; i <= scan && days.length < maxDays; i += 1) {
      const date = addDays(today, i);
      const slots = availableSlots(date, rules, blocked, nowMs);
      if (slots.length > 0) {
        days.push({ date, slots, calendarChecked: calendar.checked });
      }
    }
    return { days, calendarChecked: calendar.checked };
  }

  // --- create --------------------------------------------------------------

  async create(input: CreateBookingInput): Promise<CreateBookingResult> {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const settings = await this.settingsService.get(input.tenantId);
    if (input.source === 'agent' && settings.mode === 'disabled') {
      throw new BookingsDisabledError();
    }
    const service = await this.catalog.get(input.tenantId, input.serviceId);
    if (!service || !service.active) throw new BookingServiceNotFoundError();

    const enforceSchedule = input.source === 'agent';
    if (enforceSchedule && !this.inBookingRange(settings, input.date, nowMs)) {
      throw new BookingSlotError('out_of_range');
    }

    const bounds = this.dayBounds(input.date, settings.timeZone);
    const calendar = await this.calendarBusy(
      input.tenantId,
      bounds.startMs,
      bounds.endMs,
    );

    const status: BookingStatus =
      input.source === 'console'
        ? (input.requestedStatus ?? 'confirmed')
        : settings.mode === 'auto' && calendar.checked
          ? 'confirmed'
          : 'requested';

    let row: BookingRow;
    let duplicate = false;
    try {
      ({ row, duplicate } = await this.tenantContext.withTenantTx(
        async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`booking:${input.tenantId}`}, 0))`,
          );

          const [existing] = await tx
            .select()
            .from(bookings)
            .where(
              and(
                eq(bookings.tenantId, input.tenantId),
                eq(bookings.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1);
          if (existing) return { row: existing, duplicate: true };

          const active = await tx
            .select({
              startsAt: bookings.startsAt,
              endsAt: bookings.endsAt,
              bufferMinutes: bookings.bufferMinutes,
            })
            .from(bookings)
            .where(
              and(
                eq(bookings.tenantId, input.tenantId),
                inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
                lt(bookings.startsAt, new Date(bounds.endMs + LOOKBACK_MS)),
                gt(bookings.endsAt, new Date(bounds.startMs - LOOKBACK_MS)),
              ),
            );
          const blocked: Interval[] = [
            ...active.map((r) => ({
              startMs: r.startsAt.getTime(),
              endMs: r.endsAt.getTime() + r.bufferMinutes * 60_000,
            })),
            ...calendar.intervals,
          ];

          const slot = this.resolveSlot(
            input.date,
            input.startMinutes,
            settings,
            service,
            blocked,
            nowMs,
            enforceSchedule,
          );

          const [inserted] = await tx
            .insert(bookings)
            .values({
              tenantId: input.tenantId,
              reference: generateBookingReference(),
              serviceId: service.id,
              customerId: input.customerId,
              conversationId: input.conversationId,
              status,
              startsAt: new Date(slot.startMs),
              endsAt: new Date(slot.endMs),
              bufferMinutes: service.bufferMinutes,
              timeZone: settings.timeZone,
              serviceName: service.name,
              location: service.location,
              customerName: input.customerName,
              customerPhone: input.customerPhone,
              customerEmail: input.customerEmail,
              notes: input.notes,
              calendarSyncStatus:
                status === 'confirmed' && calendar.connected
                  ? 'pending'
                  : 'not_applicable',
              source: input.source,
              idempotencyKey: input.idempotencyKey,
              createdBy: input.createdBy,
              confirmedAt: status === 'confirmed' ? now : null,
              confirmedBy: status === 'confirmed' ? input.createdBy : null,
            })
            .returning();
          return { row: inserted, duplicate: false };
        },
        input.tenantId,
      ));
    } catch (error) {
      // The advisory lock serialises this tenant's inserts, so the only unique
      // violation left is a reference collision (about 1 in 700M per pair).
      // Reported as `taken`, which sends the agent back to check_availability.
      if (isUniqueViolation(error)) {
        throw new BookingSlotError('taken');
      }
      throw error;
    }

    if (!duplicate) {
      if (row.status === 'confirmed' && row.calendarSyncStatus === 'pending') {
        row = await this.syncToCalendar(row);
      }
      if (row.status === 'requested' && input.source === 'agent') {
        await this.notifyRequested(row);
      }
    }
    return { booking: toBookingRecord(row), duplicate };
  }

  private resolveSlot(
    date: LocalDate,
    startMinutes: number,
    settings: BookingSettings,
    service: NonNullable<ServiceRow>,
    blocked: Interval[],
    nowMs: number,
    enforceSchedule: boolean,
  ): { startMs: number; endMs: number } {
    if (enforceSchedule) {
      const result = checkSlot(
        date,
        startMinutes,
        this.rulesFor(settings, service),
        blocked,
        nowMs,
      );
      if (!result.ok) throw new BookingSlotError(result.reason);
      return result.slot;
    }
    // Console: the business may book outside its own hours or grid, but never
    // on top of another appointment.
    const startMs = zonedWallTimeToInstant(
      date,
      startMinutes,
      settings.timeZone,
    );
    if (startMs === null) throw new BookingSlotError('invalid_time');
    const endMs = startMs + service.durationMinutes * 60_000;
    const occupied = { startMs, endMs: endMs + service.bufferMinutes * 60_000 };
    if (blocked.some((b) => overlaps(occupied, b))) {
      throw new BookingSlotError('taken');
    }
    return { startMs, endMs };
  }

  /** Writes the calendar event for a confirmed booking. Never throws: a calendar failure is recorded on the row. */
  private async syncToCalendar(row: BookingRow): Promise<BookingRow> {
    let patch: Partial<BookingRow>;
    try {
      const active = await this.calendars.getActive(row.tenantId);
      if (!active) {
        patch = {
          calendarSyncStatus: 'failed',
          calendarSyncError: 'Calendar is not connected',
        };
      } else {
        const event = await this.calendarProvider.createEvent(
          active.credentials,
          active.calendarId,
          {
            summary: `${row.serviceName} — ${row.customerName}`,
            description: [
              `Booking ${row.reference}`,
              row.customerPhone ? `Phone: ${row.customerPhone}` : null,
              row.notes ? `Notes: ${row.notes}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            startMs: row.startsAt.getTime(),
            endMs: row.endsAt.getTime(),
            timeZone: row.timeZone,
            withVideoMeeting: row.location === 'online',
            attendeeEmail: row.customerEmail,
            requestId: row.id.replace(/-/g, ''),
          },
        );
        patch = {
          calendarEventId: event.eventId,
          meetingUrl: event.meetingUrl,
          calendarSyncStatus: 'synced',
          calendarSyncError: null,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CalendarAuthError) {
        await this.calendars.markNeedsReconnect(row.tenantId, message);
      }
      this.logger.warn(
        `calendar event for booking ${row.reference} (tenant ${row.tenantId}) failed: ${message}`,
        BookingService.name,
      );
      patch = {
        calendarSyncStatus: 'failed',
        calendarSyncError: message.slice(0, 500),
      };
    }
    const [updated] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(bookings)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(eq(bookings.tenantId, row.tenantId), eq(bookings.id, row.id)),
          )
          .returning(),
      row.tenantId,
    );
    return updated ?? row;
  }

  private async notifyRequested(row: BookingRow): Promise<void> {
    const local = wallTimeOf(row.startsAt.getTime(), row.timeZone);
    const when = `${formatLocalDate(local)} ${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
    try {
      await this.notifications.record({
        tenantId: row.tenantId,
        ...notificationContent.bookingRequested({
          bookingRef: row.reference,
          service: row.serviceName,
          when,
          customer: row.customerName,
        }),
        severity: 'warning',
        entityType: 'booking',
        entityId: row.id,
        dedupKey: `booking_requested:${row.id}`,
      });
    } catch (error) {
      this.logger.error(
        `could not record booking_requested for ${row.reference}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        BookingService.name,
      );
    }
  }

  // --- read ----------------------------------------------------------------

  async get(tenantId: string, id: string): Promise<BookingRecord | null> {
    const row = await this.getRow(tenantId, id);
    return row ? toBookingRecord(row) : null;
  }

  private async getRow(
    tenantId: string,
    id: string,
  ): Promise<BookingRow | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(bookings)
          .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)))
          .limit(1),
      tenantId,
    );
    return row ?? null;
  }

  /** By start time — ascending (agenda) or descending (history) — keyset-paged. */
  async list(
    tenantId: string,
    query: ListBookingsQuery,
  ): Promise<{ items: BookingRecord[]; nextCursor: string | null }> {
    const desc_ = query.order === 'desc';
    const conditions: (SQL | undefined)[] = [eq(bookings.tenantId, tenantId)];
    if (query.status) conditions.push(eq(bookings.status, query.status));
    if (query.from) conditions.push(gte(bookings.startsAt, query.from));
    if (query.to) conditions.push(lt(bookings.startsAt, query.to));
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    if (after) {
      const ts = sql`${after.ts}::timestamptz`;
      conditions.push(
        desc_
          ? or(
              sql`${bookings.startsAt} < ${ts}`,
              and(sql`${bookings.startsAt} = ${ts}`, lt(bookings.id, after.id)),
            )
          : or(
              sql`${bookings.startsAt} > ${ts}`,
              and(sql`${bookings.startsAt} = ${ts}`, gt(bookings.id, after.id)),
            ),
      );
    }
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ booking: bookings, cursorTs: STARTS_AT_MICROS })
          .from(bookings)
          .where(and(...conditions))
          .orderBy(
            ...(desc_
              ? [desc(bookings.startsAt), desc(bookings.id)]
              : [asc(bookings.startsAt), asc(bookings.id)]),
          )
          .limit(query.limit + 1),
      tenantId,
    );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toBookingRecord(r.booking)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(last.cursorTs, last.booking.id)
          : null,
    };
  }

  /** Most recent first; for the customer view and the agent's context. */
  async listForCustomer(
    tenantId: string,
    customerId: string,
    limit = 10,
  ): Promise<BookingRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(bookings)
          .where(
            and(
              eq(bookings.tenantId, tenantId),
              eq(bookings.customerId, customerId),
            ),
          )
          .orderBy(desc(bookings.startsAt))
          .limit(limit),
      tenantId,
    );
    return rows.map(toBookingRecord);
  }

  // --- lifecycle -----------------------------------------------------------

  private async transition(
    tenantId: string,
    id: string,
    to: BookingStatus,
    extra: Partial<BookingRow>,
  ): Promise<BookingRow> {
    const current = await this.getRow(tenantId, id);
    if (!current) throw new BookingNotFoundError();
    if (!canTransition(current.status, to)) {
      throw new InvalidBookingTransitionError(current.status, to);
    }
    // Conditional on the status we read: two people pressing different
    // buttons at once cannot both win.
    const [updated] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(bookings)
          .set({ ...extra, status: to, updatedAt: new Date() })
          .where(
            and(
              eq(bookings.tenantId, tenantId),
              eq(bookings.id, id),
              eq(bookings.status, current.status),
            ),
          )
          .returning(),
      tenantId,
    );
    if (!updated) throw new InvalidBookingTransitionError(current.status, to);
    return updated;
  }

  async confirm(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<BookingRecord> {
    const connected = await this.calendars.hasConnection(tenantId);
    let row = await this.transition(tenantId, id, 'confirmed', {
      confirmedAt: new Date(),
      confirmedBy: userId,
      calendarSyncStatus: connected ? 'pending' : 'not_applicable',
    });
    if (row.calendarSyncStatus === 'pending')
      row = await this.syncToCalendar(row);
    return toBookingRecord(row);
  }

  async cancel(
    tenantId: string,
    id: string,
    reason: string | null,
  ): Promise<BookingRecord> {
    const row = await this.transition(tenantId, id, 'cancelled', {
      cancelledAt: new Date(),
      cancelReason: reason,
    });
    if (row.calendarEventId) {
      try {
        const active = await this.calendars.getActive(tenantId);
        if (active) {
          await this.calendarProvider.deleteEvent(
            active.credentials,
            active.calendarId,
            row.calendarEventId,
          );
        }
      } catch (error) {
        if (error instanceof CalendarAuthError) {
          await this.calendars.markNeedsReconnect(tenantId, error.message);
        }
        this.logger.warn(
          `could not delete calendar event for cancelled booking ${row.reference}: ${error instanceof Error ? error.message : String(error)}`,
          BookingService.name,
        );
      }
    }
    return toBookingRecord(row);
  }

  async markOutcome(
    tenantId: string,
    id: string,
    outcome: 'completed' | 'no_show',
    now: Date = new Date(),
  ): Promise<BookingRecord> {
    const current = await this.getRow(tenantId, id);
    if (!current) throw new BookingNotFoundError();
    if (current.startsAt.getTime() > now.getTime()) {
      throw new InvalidBookingTransitionError('upcoming', outcome);
    }
    return toBookingRecord(await this.transition(tenantId, id, outcome, {}));
  }

  /** Console idempotency: one key per create click. */
  static consoleIdempotencyKey(): string {
    return `console:${randomUUID()}`;
  }
}
