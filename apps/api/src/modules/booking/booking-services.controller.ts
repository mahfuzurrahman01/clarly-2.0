import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
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
  BookingCatalogService,
  toServiceRecord,
} from './booking-catalog.service';
import {
  BookingServiceDto,
  BookingServiceListDto,
  createBookingServiceBodySchema,
  updateBookingServiceBodySchema,
  type BookingServiceRecord,
  type CreateBookingServiceBody,
  type UpdateBookingServiceBody,
} from './booking.dto';

@ApiTags('bookings')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('bookings/services')
export class BookingServicesController {
  constructor(private readonly catalog: BookingCatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'Bookable services',
    description: 'Active and inactive, by name.',
  })
  @ApiOkResponse({ type: BookingServiceListDto })
  async list(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<BookingServiceRecord[]> {
    return (await this.catalog.list(auth.tenantId)).map(toServiceRecord);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Add a bookable service',
    description:
      'Name (unique per workspace, case-insensitive → 409), duration 5–480 min, optional buffer 0–240 min kept free after each appointment, optional price + ISO currency (null price = on request), location `in_person` | `online` (gets a Google Meet link when a calendar is connected) | `phone`.',
  })
  @ApiOkResponse({ type: BookingServiceDto })
  @ApiValidationErrorResponse()
  async create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createBookingServiceBodySchema))
    body: CreateBookingServiceBody,
    @Audit() audit: AuditDetail,
  ): Promise<BookingServiceRecord> {
    const row = await this.catalog.create(auth.tenantId, body);
    audit.describe('booking_service.created', { serviceName: row.name });
    return toServiceRecord(row);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Edit a bookable service',
    description:
      'Partial update. Set `active: false` to stop offering it; existing bookings keep their snapshot of the name and length. Services are never deleted, because bookings refer to them.',
  })
  @ApiOkResponse({ type: BookingServiceDto })
  @ApiValidationErrorResponse()
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateBookingServiceBodySchema))
    body: UpdateBookingServiceBody,
    @Audit() audit: AuditDetail,
  ): Promise<BookingServiceRecord> {
    const row = await this.catalog.update(auth.tenantId, id, body);
    if (!row) throw new NotFoundException('Service not found');
    audit.describe('booking_service.updated', { serviceName: row.name });
    return toServiceRecord(row);
  }
}
