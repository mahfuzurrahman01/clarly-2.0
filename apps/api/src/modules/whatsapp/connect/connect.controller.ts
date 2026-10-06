// Channel/connect (WhatsappModule): the authenticated WhatsApp connect API.
// Admin-only (workspace-config actions, same tier as TenantPolicyController)
// and behind EntitlementGuard, which blocks lapsed tenants but lets a
// trialing tenant through (D16: no card needed to connect).
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiErrorDto,
} from '../../../common/api-error.dto';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CurrentAuth } from '../../auth/current-auth.decorator';
import type { TenantAuthContext } from '../../auth/jwt-claims';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { EntitlementGuard } from '../../billing/entitlement.guard';
import {
  ConnectedNumberDto,
  EmbeddedSignupBodyDto,
  EmbeddedSignupResponseDto,
  embeddedSignupBodySchema,
  type ConnectedNumber,
  type EmbeddedSignupResult,
} from './connect.dto';
import { ConnectService } from './connect.service';

@ApiTags('whatsapp-connect')
@Controller('whatsapp/connect')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
export class ConnectController {
  constructor(private readonly connect: ConnectService) {}

  @Get('numbers')
  @ApiOperation({
    summary: "List the tenant's connected WhatsApp numbers",
    description:
      'Never returns credentials. Each number carries its connection state; a `reconnect_required` number has a `connectionError` saying what the admin must do.',
  })
  @ApiOkResponse({ type: ConnectedNumberDto, isArray: true })
  async numbers(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<ConnectedNumber[]> {
    return this.connect.listNumbers(auth.tenantId);
  }

  @Post('embedded-signup')
  @ApiOperation({
    summary: 'Complete Meta Embedded Signup for a WhatsApp number',
    description:
      'Send the `code` from FB.login and the `waba_id` / `phone_number_id` from the WA_EMBEDDED_SIGNUP message. The server exchanges the code, checks both ids against what Meta granted, subscribes the WABA to our webhooks and registers the number. Any non-2xx response means nothing was stored. A 201 always means the number is stored: check `connectionState` — `reconnect_required` comes with a `connectionError` to show the admin. 403 is also returned when the WABA was not granted to our app in this signup or the number is not on that WABA.',
  })
  @ApiCreatedResponse({ type: EmbeddedSignupResponseDto })
  @ApiBadRequestResponse({
    description:
      'Invalid body, a code that was already used or has expired, or a multi-number WABA with no phoneNumberId.',
    type: ApiErrorDto,
  })
  @ApiConflictResponse({
    description: 'This number is already connected to another workspace.',
    type: ApiErrorDto,
  })
  @ApiBadGatewayResponse({
    description:
      'Meta failed before anything was stored. Safe to retry with a fresh signup.',
    type: ApiErrorDto,
  })
  async embeddedSignup(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(embeddedSignupBodySchema))
    body: EmbeddedSignupBodyDto,
  ): Promise<EmbeddedSignupResult> {
    return this.connect.completeEmbeddedSignup(auth.tenantId, body);
  }
}
