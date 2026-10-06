// Product shell (OutboundModule, F11): where a tenant points their own system
// at the data the agent collects.
//
// Admin-only: a webhook endpoint receives customer data and is authenticated
// by a secret, which makes registering one a security decision rather than a
// support task.
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  createWebhookBodySchema,
  CreateWebhookBodyDto,
  WebhookCreatedDto,
  WebhookListDto,
} from './outbound.dto.zod';
import {
  TenantWebhookService,
  type TenantWebhookRecord,
} from './tenant-webhook.service';
import { UnsafeWebhookUrlError } from './webhook-url';

@ApiTags('outbound')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('outbound/webhooks')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class OutboundController {
  constructor(private readonly webhooks: TenantWebhookService) {}

  @Get()
  @ApiOperation({
    summary: 'Registered endpoints',
    description:
      'Each with its last successful and last failed delivery, so a broken endpoint is visible here rather than only in our logs. Secrets are never returned.',
  })
  @ApiOkResponse({ type: WebhookListDto })
  list(@CurrentAuth() auth: TenantAuthContext): Promise<TenantWebhookRecord[]> {
    return this.webhooks.list(auth.tenantId);
  }

  @Post()
  @ApiOperation({
    summary: 'Register an endpoint',
    description:
      'Returns the signing secret **once**. Every delivery carries `X-Webhook-Signature: sha256=<hmac>` over `<timestamp>.<body>` and `X-Webhook-Timestamp`; verify both, and reject a timestamp that is far from now, or a captured request can be replayed at you forever.\\n\\nThe URL must be https and must not resolve inside a private network — that check runs again at delivery time, because a hostname that is public today can point at internal infrastructure tomorrow.\\n\\nDeliveries retry with backoff and then stop; the failure is recorded on the endpoint rather than retried forever.',
  })
  @ApiCreatedResponse({ type: WebhookCreatedDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 400,
    description: 'The URL is not https, or resolves inside a private network.',
    type: ApiErrorDto,
  })
  async create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createWebhookBodySchema))
    body: CreateWebhookBodyDto,
  ): Promise<TenantWebhookRecord & { secret: string }> {
    // Generated here, never accepted from the client: a tenant-chosen secret
    // is a weak secret, and the one thing this value must be is unguessable.
    const secret = randomBytes(32).toString('hex');

    try {
      const record = await this.webhooks.create(
        auth.tenantId,
        body.url,
        body.events,
        secret,
      );
      return { ...record, secret };
    } catch (error) {
      if (error instanceof UnsafeWebhookUrlError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove an endpoint' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Removed.' })
  @ApiResponse({
    status: 404,
    description: 'No such endpoint in the calling tenant.',
    type: ApiErrorDto,
  })
  async remove(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.webhooks.remove(auth.tenantId, id);
    return { ok: true };
  }
}
