// Product shell (AuditModule): reading the audit trail.
//
// Admin-only, and read-only — there is deliberately no write, edit, or delete
// route here. Entries come from AuditInterceptor and nowhere else; the table
// itself denies UPDATE and DELETE to the app role (migration 0037). A log the
// product can edit answers no question worth asking.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  AuditLogEntryListDto,
  ListAuditLogQueryDto,
  listAuditLogQuerySchema,
  type AuditLogEntry,
} from './audit-log.dto';
import { AuditLogService } from './audit-log.service';

@ApiTags('audit')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('audit-log')
@UseGuards(RolesGuard)
@Roles('admin')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the audit trail',
    description:
      'Every state-changing action taken in this workspace by a signed-in user, newest first. Reads are not recorded — only actions that changed something, plus attempts that failed.\n\n`route` is the route **pattern** (`/knowledge-base/documents/:id`), so grouping by it answers "show me every document deletion"; the specific thing acted on is `targetId`.\n\n`detail` is a plain-language description of what changed, when the endpoint supplied one. Null is normal and does not mean the entry is incomplete — the entry itself is always recorded.\n\n`actorEmail` is resolved live from the team directory, never stored, so a renamed account never leaves a stale entry. It is null for someone no longer on the team; their `actorUserId` still identifies them.\n\n`actorRole` is the role the actor held **at the time**, not the role they hold now.\n\nPaging is keyset, not offset: pass the `createdAt` of your last row as `before`. That stays correct while new entries are landing, which an offset does not.',
  })
  @ApiOkResponse({ type: AuditLogEntryListDto })
  @ApiValidationErrorResponse()
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema))
    query: ListAuditLogQueryDto,
  ): Promise<AuditLogEntry[]> {
    return this.auditLog.list(auth.tenantId, query);
  }
}
