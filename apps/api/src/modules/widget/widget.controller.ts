// Clarly 2.0 S3: Settings → Website chat (tenant JWT).
import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { WidgetConfigService, toWidgetRecord } from './widget-config.service';
import {
  WidgetConfigDto,
  updateWidgetBodySchema,
  type UpdateWidgetBody,
  type WidgetConfigRecord,
} from './widget.dto';

@ApiTags('widget')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('widget')
export class WidgetController {
  constructor(private readonly widgets: WidgetConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'The website chat widget',
    description:
      'Created on first read (disabled, no allowed websites) so there is always a key to show. Admin and agent may read it.',
  })
  @ApiOkResponse({ type: WidgetConfigDto })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<WidgetConfigRecord> {
    return toWidgetRecord(await this.widgets.getOrCreate(auth.tenantId));
  }

  @Patch()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Update the website chat widget',
    description:
      'Partial. `allowedOrigins`: up to 20 exact origins (`https://shop.example.com`; plain http only for localhost), normalised and de-duplicated. The widget answers only on those websites, and only while `enabled`.',
  })
  @ApiOkResponse({ type: WidgetConfigDto })
  @ApiValidationErrorResponse()
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(updateWidgetBodySchema)) body: UpdateWidgetBody,
    @Audit() audit: AuditDetail,
  ): Promise<WidgetConfigRecord> {
    const row = await this.widgets.update(auth.tenantId, body);
    audit.describe('widget.updated', {
      enabled: row.enabled ? 'on' : 'off',
      origins: String(row.allowedOrigins.length),
    });
    return toWidgetRecord(row);
  }

  @Post('rotate-key')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Issue a new widget key',
    description:
      'The old embed snippet stops working immediately; paste the new one on every website.',
  })
  @ApiOkResponse({ type: WidgetConfigDto })
  async rotate(
    @CurrentAuth() auth: TenantAuthContext,
    @Audit() audit: AuditDetail,
  ): Promise<WidgetConfigRecord> {
    const row = await this.widgets.rotateKey(auth.tenantId);
    audit.describe('widget.key_rotated', {});
    return toWidgetRecord(row);
  }
}
