// Channel (MetaChannelModule, Feature 16; connect flow reworked in Gulf
// T4 / D4): the console's channel-connection surface for Facebook Messenger
// and Instagram DM.
//
// Admin-only, matching every other tenant-configuration surface (T14 draws
// the admin/agent line at tenant config, not at ticket operations):
// connecting a channel changes where a tenant's customer conversations
// arrive, which is not an agent-level action.
//
// The Facebook Login popup itself runs in the console (Meta's JS SDK). What
// the browser sends here is ONLY the short-lived user token it yields
// (`POST /channels/meta/pages`). Page tokens never cross the browser: the
// server reads them from Meta's `/me/accounts` and connects a page only if
// Meta listed it for that user (MetaConnectService). That closes the page
// squat the pre-T4 `pageAccessToken` body field allowed.
import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AppLoggerService } from '../core';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { MetaGraphError } from '../meta-graph/meta-graph.module';
import {
  ConnectSocialChannelBodyDto,
  connectSocialChannelBodySchema,
  MetaConnectHandshakeDto,
  SocialChannelListDto,
  StartMetaConnectBodyDto,
  startMetaConnectBodySchema,
} from './meta-channel.dto';
import { MetaConnectService } from './meta-connect.service';
import { SocialChannelDirectory } from './social-channel-directory.service';
import {
  MetaConnectHandshakeExpiredError,
  MetaInstagramNotLinkedError,
  MetaLoginTokenRejectedError,
  MetaPageNotManagedError,
  SocialChannelOwnedByAnotherTenantError,
} from './social-channel.errors';

@ApiTags('channels')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('channels/meta')
@UseGuards(RolesGuard)
@Roles('admin')
export class MetaChannelController {
  constructor(
    private readonly directory: SocialChannelDirectory,
    private readonly connectService: MetaConnectService,
    private readonly logger: AppLoggerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List connected Messenger / Instagram channels',
    description:
      'Every Meta social channel this workspace has connected, with its token state. Access tokens are never included in any response.',
  })
  @ApiOkResponse({ type: SocialChannelListDto })
  async list(@CurrentAuth() auth: TenantAuthContext) {
    const channels = await this.directory.listForTenant(auth.tenantId);
    return channels.map((channel) => ({
      ...channel,
      tokenExpiresAt: channel.tokenExpiresAt?.toISOString() ?? null,
    }));
  }

  @Post('pages')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Step 1 of connecting Messenger / Instagram: list the pages a Facebook login manages',
    description:
      "Send the short-lived user token from Facebook Login for Business. The server exchanges it for a long-lived token, reads the user's pages (and linked Instagram accounts) from Meta, and keeps them server-side for 15 minutes under `handshakeId`. No token is ever returned.",
  })
  @ApiOkResponse({ type: MetaConnectHandshakeDto })
  @ApiBadRequestResponse({
    description:
      'Body failed validation (`message` is the Zod issue array), or Meta rejected the Facebook Login token (expired, revoked, or for another app).',
    type: ApiErrorDto,
  })
  @ApiBadGatewayResponse({
    description: 'Meta could not be reached or failed. Retry.',
    type: ApiErrorDto,
  })
  async startConnect(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(startMetaConnectBodySchema))
    body: StartMetaConnectBodyDto,
  ) {
    try {
      const result = await this.connectService.startHandshake({
        tenantId: auth.tenantId,
        userId: auth.userId,
        userAccessToken: body.userAccessToken,
      });
      return { ...result, expiresAt: result.expiresAt.toISOString() };
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Step 2: connect (or re-connect) a page as Messenger and/or Instagram',
    description:
      "Pick a page from step 1's `handshakeId`. The server uses Meta's own page token for it, subscribes the page to our webhooks, and stores the credentials. Idempotent: re-running it for an account this workspace already has swaps the token and clears `reconnect_required`. An account connected to a DIFFERENT workspace is refused with 409.",
  })
  @ApiNoContentResponse({ description: 'Connected.' })
  @ApiValidationErrorResponse()
  @ApiForbiddenResponse({
    description:
      'The Facebook login does not manage this page (or the caller is not an admin).',
    type: ApiErrorDto,
  })
  @ApiConflictResponse({
    description: 'This Meta account is already connected to another workspace.',
    type: ApiErrorDto,
  })
  @ApiGoneResponse({
    description:
      'The handshake expired or is not yours. Log in with Facebook again.',
    type: ApiErrorDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`instagram` requested for a page with no linked Instagram account.',
    type: ApiErrorDto,
  })
  @ApiBadGatewayResponse({
    description:
      'Meta refused or failed the webhook subscription. Nothing was stored.',
    type: ApiErrorDto,
  })
  async connect(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(connectSocialChannelBodySchema))
    body: ConnectSocialChannelBodyDto,
  ): Promise<void> {
    try {
      await this.connectService.connect({
        tenantId: auth.tenantId,
        userId: auth.userId,
        handshakeId: body.handshakeId,
        pageId: body.pageId,
        channels: body.channels,
      });
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Disconnect a channel',
    description:
      'Stops inbound routing and deletes the stored credentials. Conversations and tickets already received are untouched — they are customer history, not channel configuration.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Disconnected.' })
  async disconnect(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const removed = await this.directory.disconnect(auth.tenantId, id);
    if (!removed) {
      // Same 404 for "no such channel" and "another tenant's channel" — the
      // difference is exactly what a probe would be looking for.
      throw new NotFoundException('No such channel in this workspace.');
    }
  }

  /** Maps the connect flow's domain errors to HTTP. Anything unrecognised is rethrown untouched (500). */
  private toHttpError(error: unknown): unknown {
    if (error instanceof SocialChannelOwnedByAnotherTenantError) {
      // Deliberately does not name the owning workspace: that would turn
      // this endpoint into a "which competitor has this page connected"
      // oracle for anyone with an admin account anywhere on the platform.
      return new ConflictException(
        'This Meta account is already connected to another workspace.',
      );
    }
    if (error instanceof MetaPageNotManagedError) {
      return new ForbiddenException(error.message);
    }
    if (error instanceof MetaConnectHandshakeExpiredError) {
      return new GoneException(error.message);
    }
    if (error instanceof MetaInstagramNotLinkedError) {
      return new UnprocessableEntityException(error.message);
    }
    if (error instanceof MetaLoginTokenRejectedError) {
      return new BadRequestException(error.message);
    }
    if (error instanceof MetaGraphError) {
      // The message is already token-redacted by MetaGraphClient; logged for
      // on-call, not echoed to the client.
      this.logger.warn(
        `Meta connect call failed: ${error.message}`,
        MetaChannelController.name,
      );
      return new BadGatewayException(
        'Meta could not complete the request. Try again, and check that the app was granted the requested page permissions.',
      );
    }
    return error;
  }
}
