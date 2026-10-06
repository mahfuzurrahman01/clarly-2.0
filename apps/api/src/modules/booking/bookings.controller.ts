import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { Clock } from '../core';
import { BookingCatalogService } from './booking-catalog.service';
import { BookingErrorFilter } from './booking-error.filter';
import { BookingServiceNotFoundError } from './booking-errors';
import { BookingSettingsService } from './booking-settings.service';
import { formatClock, parseClock, parseLocalDate } from './booking-time';
import {
  AvailabilityDto,
  BookingDto,
  BookingPageDto,
  availabilityQuerySchema,
  cancelBookingBodySchema,
  createBookingBodySchema,
  listBookingsQuerySchema,
  type AvailabilityQuery,
  type AvailabilityRecord,
  type BookingRecord,
  type CancelBookingBody,
  type CreateBookingBody,
  type ListBookingsQuery,
} from './booking.dto';
import { BookingService } from './booking.service';

@ApiTags('bookings')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@UseFilters(BookingErrorFilter)
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly settings: BookingSettingsService,
    private readonly catalog: BookingCatalogService,
    private readonly clock: Clock,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List bookings',
    description:
      'Ascending by start time (an agenda), keyset-paged via `nextCursor`. Filter by `status` and a `from`/`to` start window. Admin and agent.',
  })
  @ApiOkResponse({ type: BookingPageDto })
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listBookingsQuerySchema))
    query: ListBookingsQuery,
  ) {
    return this.bookingService.list(auth.tenantId, query);
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Free start times for a service on a day',
    description:
      'The same answer the agent’s check_availability tool gets, for the console’s "new booking" form.',
  })
  @ApiOkResponse({ type: AvailabilityDto })
  async availability(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: AvailabilityQuery,
  ): Promise<AvailabilityRecord> {
    const settings = await this.settings.get(auth.tenantId);
    const service = await this.catalog.get(auth.tenantId, query.serviceId);
    if (!service) throw new BookingServiceNotFoundError();
    const date = parseLocalDate(query.date);
    if (!date) throw new NotFoundException('Invalid date');
    const day = await this.bookingService.dayAvailability(
      auth.tenantId,
      settings,
      service,
      date,
      this.clock.now().getTime(),
    );
    return {
      date: query.date,
      timeZone: settings.timeZone,
      slots: day.slots.map((s) => ({
        time: s.localTime,
        startsAt: new Date(s.startMs),
        endsAt: new Date(s.endMs),
      })),
      calendarChecked: day.calendarChecked,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One booking' })
  @ApiOkResponse({ type: BookingDto })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingRecord> {
    const booking = await this.bookingService.get(auth.tenantId, id);
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  @Post()
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Add a booking from the console',
    description:
      'For a phone or walk-in customer. Local `date` + `time` in the workspace time zone. Unlike the agent, the console may book outside opening hours and off the slot grid, but never on top of another active booking (409 `taken`). Defaults to `confirmed`; a confirmed booking is written to the connected calendar.',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiValidationErrorResponse()
  async create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createBookingBodySchema))
    body: CreateBookingBody,
    @Audit() audit: AuditDetail,
  ): Promise<BookingRecord> {
    const date = parseLocalDate(body.date);
    const minutes = parseClock(body.time);
    if (!date || minutes === null)
      throw new NotFoundException('Invalid date or time');
    const { booking } = await this.bookingService.create({
      tenantId: auth.tenantId,
      serviceId: body.serviceId,
      date,
      startMinutes: minutes,
      customerName: body.customerName,
      customerPhone: body.customerPhone ?? null,
      customerEmail: body.customerEmail ?? null,
      notes: body.notes ?? null,
      customerId: null,
      conversationId: null,
      source: 'console',
      createdBy: auth.userId,
      idempotencyKey: BookingService.consoleIdempotencyKey(),
      requestedStatus: body.status,
      now: this.clock.now(),
    });
    audit.describe('booking.created', {
      bookingRef: booking.reference,
      service: booking.serviceName,
      when: `${body.date} ${formatClock(minutes)}`,
    });
    return booking;
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Confirm a requested booking',
    description:
      '409 unless it is `requested`. Writes the calendar event when a calendar is connected.',
  })
  @ApiOkResponse({ type: BookingDto })
  async confirm(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<BookingRecord> {
    const booking = await this.bookingService.confirm(
      auth.tenantId,
      id,
      auth.userId,
    );
    audit.describe('booking.confirmed', { bookingRef: booking.reference });
    return booking;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Cancel a booking',
    description:
      'From `requested` or `confirmed`. Deletes the calendar event (the customer’s invitation is withdrawn).',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiValidationErrorResponse()
  async cancel(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelBookingBodySchema))
    body: CancelBookingBody,
    @Audit() audit: AuditDetail,
  ): Promise<BookingRecord> {
    const booking = await this.bookingService.cancel(
      auth.tenantId,
      id,
      body.reason ?? null,
    );
    audit.describe('booking.cancelled', {
      bookingRef: booking.reference,
      reason: body.reason ?? '',
    });
    return booking;
  }

  @Post(':id/complete')
  @HttpCode(200)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Mark a confirmed booking as done',
    description: 'Only once it has started.',
  })
  @ApiOkResponse({ type: BookingDto })
  async complete(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<BookingRecord> {
    const booking = await this.bookingService.markOutcome(
      auth.tenantId,
      id,
      'completed',
      this.clock.now(),
    );
    audit.describe('booking.completed', { bookingRef: booking.reference });
    return booking;
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Mark a confirmed booking as a no-show',
    description: 'Only once it has started.',
  })
  @ApiOkResponse({ type: BookingDto })
  async noShow(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<BookingRecord> {
    const booking = await this.bookingService.markOutcome(
      auth.tenantId,
      id,
      'no_show',
      this.clock.now(),
    );
    audit.describe('booking.no_show', { bookingRef: booking.reference });
    return booking;
  }
}
