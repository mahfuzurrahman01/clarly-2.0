// Product shell (NotificationsModule, T4/T18): what the console reads.
//
// Ungated by role, like the kanban board: a stuck ticket is an operational
// signal every support agent needs, not tenant configuration. Gating this to
// admins would mean the person who can actually claim the ticket is the one
// who never hears about it.
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ApiErrorDto,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { EntitlementGuard } from '../billing/entitlement.guard';
import type { TenantAuthContext } from '../auth/jwt-claims';
import type { NotificationRecord } from './notification.dto';
import {
  listNotificationsQuerySchema,
  ListNotificationsQueryDto,
  NotificationListDto,
  UnreadCountDto,
} from './notifications.dto.zod';
import { NotificationService } from './notification.service';

@ApiTags('notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  /** Declared before `:id/read` so `unread-count` is not swallowed by a param route. */
  @Get('unread-count')
  @ApiOperation({
    summary: 'Unread notification count',
    description: 'The number for the bell badge. Cheap enough to poll.',
  })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<{ unread: number }> {
    return { unread: await this.notifications.unreadCount(auth.tenantId) };
  }

  @Get()
  @ApiOperation({
    summary: 'List notifications',
    description:
      'Newest first. Each row is one condition, not one observation: a ticket left unclaimed overnight appears once, however many times the sweep noticed it.',
  })
  @ApiOkResponse({ type: NotificationListDto })
  @ApiValidationErrorResponse()
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema))
    query: ListNotificationsQueryDto,
  ): Promise<NotificationRecord[]> {
    return this.notifications.list(auth.tenantId, {
      unreadOnly: query.unreadOnly,
      limit: query.limit,
    });
  }

  @Post(':id/read')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      'Idempotent — an already-read notification keeps its original read time rather than having it moved.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Marked read (or already was).' })
  @ApiResponse({
    status: 404,
    description: 'No such notification in the calling tenant.',
    type: ApiErrorDto,
  })
  async markRead(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    const updated = await this.notifications.markRead(auth.tenantId, id);
    if (!updated) {
      // Already read is success; genuinely absent is a 404. Distinguished by
      // asking, rather than reporting one as the other.
      const exists = await this.notifications.list(auth.tenantId, {
        limit: 100,
      });
      if (!exists.some((notification) => notification.id === id)) {
        throw new NotFoundException(`Notification ${id} not found`);
      }
    }
    return { ok: true };
  }

  @Post('read-all')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Mark every notification read',
    description: 'Returns how many were still unread.',
  })
  @ApiCreatedResponse({ description: 'Count of notifications marked read.' })
  async markAllRead(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<{ marked: number }> {
    return { marked: await this.notifications.markAllRead(auth.tenantId) };
  }
}
