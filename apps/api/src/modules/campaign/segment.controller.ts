// F19 (D8): segments CRUD + preview.
//
// ROUTE ORDER: this controller has no literal-vs-`:id` collision today (`
// preview` is nested under `:id`, not a sibling of it), but if a static
// segment.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  createSegmentBodySchema,
  updateSegmentBodySchema,
  type CreateSegmentBody,
  type UpdateSegmentBody,
} from './segment.dto.zod';
import { SegmentResolverService } from './segment-resolver.service';
import { SegmentService } from './segment.service';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(EntitlementGuard)
@Controller('segments')
export class SegmentController {
  constructor(
    private readonly segments: SegmentService,
    private readonly resolver: SegmentResolverService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a segment' })
  async create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createSegmentBodySchema))
    body: CreateSegmentBody,
    @Audit() audit: AuditDetail,
  ) {
    const segment = await this.segments.create(auth.tenantId, {
      name: body.name,
      description: body.description ?? null,
      definition: body.definition,
      createdBy: auth.userId,
    });
    audit.describe('segment.created', { segmentName: body.name });
    return segment;
  }

  @Get()
  @ApiOperation({ summary: 'List segments' })
  async list(@CurrentAuth() auth: TenantAuthContext) {
    return this.segments.list(auth.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a segment by id' })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.segments.require(auth.tenantId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a segment' })
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSegmentBodySchema))
    body: UpdateSegmentBody,
    @Audit() audit: AuditDetail,
  ) {
    const segment = await this.segments.update(auth.tenantId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.definition !== undefined && { definition: body.definition }),
    });
    audit.describe('segment.updated', { segmentId: id });
    return segment;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a segment (409 if a campaign references it)',
  })
  async remove(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ) {
    await this.segments.remove(auth.tenantId, id);
    audit.describe('segment.deleted', { segmentId: id });
  }

  @Post(':id/preview')
  @ApiOperation({
    summary: 'Preview a segment — COUNT(*) only, never writes a recipient row',
  })
  async preview(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const segment = await this.segments.require(auth.tenantId, id);
    const result = await this.resolver.preview(
      auth.tenantId,
      segment.definition,
    );
    await this.segments.recordLastResolved(
      auth.tenantId,
      id,
      result.count,
      result.resolvedAt,
    );
    return result;
  }
}
