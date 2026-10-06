// Clarly 2.0 S2: Google Calendar connect / status / disconnect (tenant JWT),
// and the OAuth callback (no JWT — authenticated by the signed one-shot state).
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ApiAdminOnlyResponses,
  ApiUnauthorizedResponse,
} from '../../common/api-error.dto';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AppConfigService, AppLoggerService } from '../core';
import {
  CalendarConnectUrlDto,
  CalendarStatusDto,
  type CalendarStatusRecord,
} from './booking.dto';
import { CalendarConnectionService } from './calendar/calendar-connection.service';
import {
  CalendarOAuthStateService,
  InvalidCalendarStateError,
  type CalendarConnectState,
} from './calendar/calendar-oauth-state.service';
import { CalendarProvider } from './calendar/calendar-provider.port';

const CONSOLE_SETTINGS_PATH = '/settings/bookings';

@ApiTags('bookings')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('bookings/calendar')
export class BookingCalendarController {
  constructor(
    private readonly connections: CalendarConnectionService,
    private readonly states: CalendarOAuthStateService,
    private readonly provider: CalendarProvider,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Calendar connection status',
    description:
      '`configured` says whether the platform can connect calendars at all. `connection` is null when none is connected; `status: needs_reconnect` means Google stopped accepting the grant and bookings are recorded as requests until it is reconnected.',
  })
  @ApiOkResponse({ type: CalendarStatusDto })
  status(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<CalendarStatusRecord> {
    return this.connections.status(auth.tenantId);
  }

  @Post('connect')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Start connecting Google Calendar',
    description:
      'Returns the Google consent URL to send the browser to. The signed state inside it is single-use and expires after 10 minutes. 503 when the platform has no Google OAuth client configured.',
  })
  @ApiOkResponse({ type: CalendarConnectUrlDto })
  connect(@CurrentAuth() auth: TenantAuthContext): { url: string } {
    if (!this.provider.isConfigured() || !this.states.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google Calendar connect is not configured on this platform.',
      );
    }
    return {
      url: this.provider.buildAuthUrl(
        this.states.sign(auth.tenantId, auth.userId),
      ),
    };
  }

  @Delete()
  @HttpCode(204)
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Disconnect Google Calendar',
    description:
      'Revokes the grant at Google (best effort) and forgets it. Existing calendar events are left as they are.',
  })
  async disconnect(
    @CurrentAuth() auth: TenantAuthContext,
    @Audit() audit: AuditDetail,
  ): Promise<void> {
    await this.connections.disconnect(auth.tenantId);
    audit.describe('calendar.disconnected', { provider: 'google' });
  }
}

/** Separate controller so TenantAuthMiddleware never applies to it. */
@ApiTags('bookings')
@Controller('bookings/calendar/callback')
export class BookingCalendarCallbackController {
  constructor(
    private readonly connections: CalendarConnectionService,
    private readonly states: CalendarOAuthStateService,
    private readonly provider: CalendarProvider,
    private readonly audit: AuditLogService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  @Get()
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const back = (outcome: string) =>
      res.redirect(
        302,
        `${this.config.consoleBaseUrl}${CONSOLE_SETTINGS_PATH}?calendar=${encodeURIComponent(outcome)}`,
      );

    let verified: CalendarConnectState;
    try {
      verified = await this.states.verify(state);
    } catch (e) {
      if (!(e instanceof InvalidCalendarStateError)) throw e;
      back('invalid_state');
      return;
    }
    if (error || !code) {
      back(error === 'access_denied' ? 'denied' : 'error');
      return;
    }

    try {
      const { credentials, accountEmail } =
        await this.provider.exchangeCode(code);
      await this.connections.save({
        tenantId: verified.tenantId,
        userId: verified.userId,
        nonce: verified.nonce,
        credentials,
        accountEmail,
      });
      await this.audit.record({
        tenantId: verified.tenantId,
        actorUserId: verified.userId,
        actorRole: 'admin',
        method: 'GET',
        route: '/bookings/calendar/callback',
        targetId: null,
        statusCode: 302,
        outcome: 'success',
        detail: `Connected Google Calendar${accountEmail ? ` (${accountEmail})` : ''}`,
        detailKey: 'calendar.connected',
        detailParams: { provider: 'google', account: accountEmail ?? '' },
      });
      back('connected');
    } catch (e) {
      this.logger.warn(
        `calendar connect failed for tenant ${verified.tenantId}: ${e instanceof Error ? e.message : String(e)}`,
        BookingCalendarCallbackController.name,
      );
      back('error');
    }
  }
}
