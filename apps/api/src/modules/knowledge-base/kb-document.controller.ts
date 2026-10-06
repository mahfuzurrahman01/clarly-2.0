// Product shell (KnowledgeBaseModule, Feature 6): wraps Feature 2.5's
// already-real `KbDocumentService.upload()`/`listForTenant()` in an HTTP
// surface — per that service's own header comment, "Feature 6 wraps it
// with a real UI later, no new mechanism needed then." Admin-gated: KB
// content shapes what the agent tells every customer, which is a tenant
// config concern (T14's line: admin manages tenant config, agent doesn't),
// not a per-ticket agent action.
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  KbDocumentListDto,
  KbDocumentRecordDto,
  type KbDocumentRecord,
} from './kb-document.dto';
import { KbDocumentService } from './kb-document.service';
import {
  SUPPORTED_MIME_TYPES_DESCRIPTION,
  isSupportedMimeType,
} from '../retrieval/text-extraction';

/** The same predicate RetrievalIngestService gates on — imported, not re-declared, so upload-time 400s and worker-side failures can never drift apart. Rejecting here gives a clear 400 at upload time instead of the file silently failing three steps later inside the `kb-ingest` worker. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@ApiTags('knowledge-base')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('knowledge-base/documents')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class KbDocumentController {
  constructor(private readonly kbDocuments: KbDocumentService) {}

  @Get()
  @ApiOperation({
    summary: 'List knowledge-base documents',
    description:
      'Every KB document belonging to the calling tenant, with its ingest status. A document only becomes retrievable by the agent once its status reaches `ingested`.',
  })
  @ApiOkResponse({ type: KbDocumentListDto })
  list(@CurrentAuth() auth: TenantAuthContext): Promise<KbDocumentRecord[]> {
    return this.kbDocuments.listForTenant(auth.tenantId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one knowledge-base document',
    description:
      'A single document belonging to the calling tenant, with its current ingest status. 404 if it does not exist or belongs to another tenant — the two are deliberately indistinguishable.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: KbDocumentRecordDto })
  @ApiResponse({
    status: 404,
    description: 'No such document in the calling tenant.',
    type: ApiErrorDto,
  })
  get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KbDocumentRecord> {
    return this.kbDocuments.getForTenant(auth.tenantId, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Upload a knowledge-base document',
    description: `Stores the file and enqueues a \`kb-ingest\` job. The response comes back before ingestion runs, so \`status\` will be \`uploaded\`/\`ingest_queued\` — poll \`GET /knowledge-base/documents\` to see it reach \`ingested\`.

Limits enforced at upload time: ${MAX_UPLOAD_BYTES} bytes maximum, and the MIME type must be one of \`text/*\` (any subtype, including \`text/csv\`), \`application/pdf\`, \`application/vnd.openxmlformats-officedocument.wordprocessingml.document\` (.docx), \`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\` (.xlsx) or \`application/vnd.ms-excel\` (.xls). Violating either returns 400.

Text extraction runs asynchronously in the ingest worker, so a file that is accepted here can still end at \`status: failed\` if it turns out to be corrupt or has no extractable text — image-only/scanned PDFs are rejected that way, there is no OCR.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Multipart form with a single `file` part.',
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: `A ${SUPPORTED_MIME_TYPES_DESCRIPTION} file, at most ${MAX_UPLOAD_BYTES} bytes.`,
        },
      },
    },
  })
  @ApiCreatedResponse({ type: KbDocumentRecordDto })
  @ApiValidationErrorResponse()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentAuth() auth: TenantAuthContext,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<KbDocumentRecord> {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!isSupportedMimeType(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}" — ingestible types are ${SUPPORTED_MIME_TYPES_DESCRIPTION}`,
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`,
      );
    }

    return this.kbDocuments.upload(
      auth.tenantId,
      file.originalname,
      file.mimetype,
      file.buffer,
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a knowledge-base document',
    description:
      'Removes the document, its retrieval chunks, and its stored file, and cancels its ingest job if one is still queued. The agent stops answering from this document as soon as the call returns — deletion is not deferred to a sweep.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Deleted.' })
  @ApiResponse({
    status: 404,
    description: 'No such document in the calling tenant.',
    type: ApiErrorDto,
  })
  async remove(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<{ ok: true }> {
    const { filename, chunkCount } = await this.kbDocuments.delete(
      auth.tenantId,
      id,
    );
    // The interceptor already records that this route was called and by whom.
    // What it cannot know is which document — a uuid in the audit trail tells
    // a reviewer nothing six months from now.
    audit.describe('kb_document.deleted', { filename, chunkCount });
    return { ok: true };
  }
}
