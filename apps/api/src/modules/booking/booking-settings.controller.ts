import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  BookingSettingsDto,
  updateBookingSettingsBodySchema,
  type BookingSettingsRecord,
  type UpdateBookingSettingsBody,
} from './booking.dto';
import {
  BookingSettingsService,
  toSettingsRecord,
} from './booking-settings.service';
import { BookingToolSeederService } from './booking-tool-seeder.service';

@ApiTags('bookings')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('bookings/settings')
export class BookingSettingsController {
  constructor(
    private readonly settings: BookingSettingsService,
    private readonly tools: BookingToolSeederService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Booking settings',
    description:
      'Mode (`disabled` | `request` | `auto`), time zone, weekly opening windows, slot grid, minimum notice and booking horizon. A workspace that never saved settings reads as `disabled` with no hours.',
  })
  @ApiOkResponse({ type: BookingSettingsDto })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<BookingSettingsRecord> {
    return toSettingsRecord(await this.settings.get(auth.tenantId));
  }

  @Patch()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Update booking settings',
    description:
      'Partial update. Changing `mode` also switches the agent’s `check_availability` and `book_appointment` tools on (`request`, `auto`) or off (`disabled`). `auto` confirms bookings at once; `request` records them for a person to confirm. Weekly hours: up to three non-overlapping `HH:MM` windows per weekday (`sun`…`sat`); a day left out is closed.',
  })
  @ApiOkResponse({ type: BookingSettingsDto })
  @ApiValidationErrorResponse()
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(updateBookingSettingsBodySchema))
    body: UpdateBookingSettingsBody,
    @Audit() audit: AuditDetail,
  ): Promise<BookingSettingsRecord> {
    const before = await this.settings.get(auth.tenantId);
    const next = await this.settings.update(auth.tenantId, body);
    if (next.mode !== before.mode || body.mode !== undefined) {
      await this.tools.syncForModeBestEffort(auth.tenantId, next.mode);
    }
    audit.describe('booking_settings.updated', {
      mode: next.mode,
      timeZone: next.timeZone,
    });
    return toSettingsRecord(next);
  }
}
