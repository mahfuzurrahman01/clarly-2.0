// Requesting and collecting a copy of everything the platform holds for a
// workspace. GDPR Article 15, and a routine procurement ask.
import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiAdminOnlyResponses, ApiErrorDto } from '../../common/api-error.dto';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  DataExportDto,
  DataExportListDto,
  type DataExportRecord,
} from './data-export.dto';
import { DataExportService } from './data-export.service';

const EXPORT_ID_PARAM = { name: 'id', format: 'uuid' } as const;

@ApiTags('data-export')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('data-exports')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class DataExportController {
  constructor(private readonly exports: DataExportService) {}

  @Post()
  @ApiOperation({
    summary: 'Request a data export',
    description:
      'Queues a complete copy of this workspace: conversations, messages, customers, tickets, knowledge-base document records, templates, agent configuration and versions, telemetry, outcomes, notifications, webhooks, subscription, and the audit log.\n\nAsynchronous by necessity — a busy workspace has hundreds of thousands of messages. Poll `GET /data-exports/:id` until `status` is `ready`, then download it.\n\n**One at a time.** A second request while one is `pending` or `running` returns 409, because assembling an export reads every row the workspace owns and a retrying client would otherwise queue a stack of full-table scans against itself.\n\nThe finished bundle expires (default 7 days) and is deleted from storage. The record survives so you can still see the export happened; only the copy of the data goes.',
  })
  @ApiCreatedResponse({ type: DataExportDto })
  @ApiConflictResponse({
    description: 'An export is already being prepared for this workspace.',
  })
  async request(
    @CurrentAuth() auth: TenantAuthContext,
    @Audit() audit: AuditDetail,
  ): Promise<DataExportRecord> {
    const record = await this.exports.request(auth.tenantId, auth.userId);
    audit.describe('data_export.requested', { exportId: record.id });
    return record;
  }

  @Get()
  @ApiOperation({
    summary: 'List data exports',
    description:
      'The 50 most recent export requests for this workspace, newest first. An entry whose `expiresAt` has passed has had its bundle deleted; `rowCounts` still shows what it contained.',
  })
  @ApiOkResponse({ type: DataExportListDto })
  list(@CurrentAuth() auth: TenantAuthContext): Promise<DataExportRecord[]> {
    return this.exports.list(auth.tenantId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Check one export',
    description:
      'Poll this until `status` is `ready`. `rowCounts` shows how many rows each table contributed, so completeness can be confirmed without parsing the bundle. `failed` carries the reason in `error`.',
  })
  @ApiParam(EXPORT_ID_PARAM)
  @ApiOkResponse({ type: DataExportDto })
  get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DataExportRecord> {
    return this.exports.get(auth.tenantId, id);
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download the bundle',
    description:
      "The export as one JSON document.\n\nServed as an **attachment** with `X-Content-Type-Options: nosniff` — it contains customer-authored text throughout, and serving that inline off an authenticated origin is how a transcript becomes an XSS vector.\n\n409 while the export is still `pending` or `running`, if it `failed`, or once it has expired: the export exists in each case, it just cannot be handed over. Another tenant's export id 404s exactly as a non-existent one does.",
  })
  @ApiParam(EXPORT_ID_PARAM)
  @ApiOkResponse({
    description: 'The bundle.',
    content: { 'application/json': {} },
  })
  @ApiConflictResponse({
    description: 'Not ready, failed, or expired.',
    type: ApiErrorDto,
  })
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
    @Audit() audit: AuditDetail,
  ): Promise<void> {
    const { content, filename } = await this.exports.download(
      auth.tenantId,
      id,
    );
    // Downloading a full copy of the workspace is exactly the event a security
    // review wants to see, so it is named rather than left as a bare route.
    audit.describe('data_export.downloaded', { exportId: id });

    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', content.byteLength);
    response.end(content);
  }
}
