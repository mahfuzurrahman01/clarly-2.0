// Product shell (TemplatesModule, F12): the tenant's message template library.
//
// Split by role rather than gated wholesale: reading is what an agent does
// every time they reach for a canned reply mid-conversation, so it follows
// KanbanModule's "the tenant's own support traffic is not admin-only" line.
// Writing is not — a WhatsApp template is registered with Meta under the
// tenant's WABA, and a bad one is a policy problem against their business
// account, which makes authoring it a config decision (T14).
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  MessageTemplateService,
  type MessageTemplateRecord,
} from './message-template.service';
import { TemplateBodyError, renderTemplateBody } from './template-body';
import {
  TemplateSubmissionService,
  type TemplateSubmissionResult,
} from './template-submission.service';
import {
  TemplateSyncService,
  type TemplateSyncResult,
} from './template-sync.service';
import {
  createTemplateBodySchema,
  listTemplatesQuerySchema,
  previewTemplateBodySchema,
  updateTemplateBodySchema,
  CreateTemplateBodyDto,
  ListTemplatesQueryDto,
  PreviewTemplateBodyDto,
  TemplateListDto,
  TemplatePreviewDto,
  TemplateRecordDto,
  TemplateSubmissionResultDto,
  TemplateSyncResultDto,
  UpdateTemplateBodyDto,
} from './templates.dto.zod';

const TEMPLATE_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description: 'Template id.',
} as const;

const NOT_FOUND = {
  status: 404,
  description: 'No such template in the calling tenant.',
  type: ApiErrorDto,
} as const;

@ApiTags('templates')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('templates')
@UseGuards(RolesGuard, EntitlementGuard)
export class TemplatesController {
  constructor(
    private readonly templates: MessageTemplateService,
    private readonly sync: TemplateSyncService,
    private readonly submission: TemplateSubmissionService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List templates',
    description:
      "The tenant's whole library, name order. Filter by `kind` to get the two lists a console actually shows: canned replies while the 24-hour window is open, WhatsApp templates once it has shut.\n\nReadable by both roles — an agent picking a canned reply mid-conversation is the main use.",
  })
  @ApiOkResponse({ type: TemplateListDto })
  @ApiValidationErrorResponse()
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listTemplatesQuerySchema))
    query: ListTemplatesQueryDto,
  ): Promise<MessageTemplateRecord[]> {
    return this.templates.list(auth.tenantId, { kind: query.kind });
  }

  /** Declared before `:id` — Nest matches in declaration order, and the param route would otherwise swallow this. */
  @Post('sync')
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Reconcile approval state with WhatsApp',
    description:
      'Asks each connected number\'s WhatsApp Business Account what it actually approved, and corrects the stored status. Until this runs, every WhatsApp template here is `pending` and will not send — a status we never checked is not one we should let a message out on.\n\n`unknownToBsp` lists templates stored here under a name your account does not have; they are left alone rather than deleted, because the usual cause is a typo at one end rather than a template that vanished.\n\n`unreported: true` means nothing could be reached — no credentials, no `wabaId`, or an adapter with no listing API. Nothing is changed in that case, deliberately: treating silence as "you have no templates" would invalidate every approved one you have.',
  })
  @ApiCreatedResponse({ type: TemplateSyncResultDto })
  syncTemplates(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<TemplateSyncResult> {
    return this.sync.sync(auth.tenantId);
  }

  @Post(':id/submit')
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Submit a template to WhatsApp for review',
    description:
      "Registers this template with the connected WhatsApp Business account so it can be reviewed. **Until this runs, a `whatsapp_template` stays `pending` forever and will never send** — creating a template here is a local write only, deliberately, so that a WhatsApp outage cannot lose the body you authored.\n\nAcceptance is not approval. On success the template stays `pending`; only `POST /templates/sync` may move it to `approved`, because that reads WhatsApp's own verdict rather than trusting ours.\n\n`submitted: false` with an `unsupportedReason` means no connected number could register it — no WhatsApp number linked, incomplete credentials, or a channel whose API does not support submission. Nothing is changed in that case.\n\n400 when the template is a `canned_reply` (no WhatsApp counterpart), when it is already `approved` (edit the body first, which resets it to pending), or when a `{{n}}` placeholder has no example value — WhatsApp rejects a template it cannot see filled in.",
  })
  @ApiParam(TEMPLATE_ID_PARAM)
  @ApiCreatedResponse({ type: TemplateSubmissionResultDto })
  @ApiResponse(NOT_FOUND)
  submitTemplate(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TemplateSubmissionResult> {
    return this.submission.submit(auth.tenantId, id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one template' })
  @ApiParam(TEMPLATE_ID_PARAM)
  @ApiOkResponse({ type: TemplateRecordDto })
  @ApiResponse(NOT_FOUND)
  get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageTemplateRecord> {
    return this.templates.require(auth.tenantId, id);
  }

  @Post(':id/preview')
  @ApiOperation({
    summary: 'Preview a filled template',
    description:
      'Renders the body with the supplied values and sends nothing. What a person sees before committing to a message a customer cannot un-read — and the only way to check a `{{2}}` landed where they meant it to.',
  })
  @ApiParam(TEMPLATE_ID_PARAM)
  @ApiCreatedResponse({ type: TemplatePreviewDto })
  @ApiValidationErrorResponse()
  @ApiResponse(NOT_FOUND)
  async preview(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(previewTemplateBodySchema))
    body: PreviewTemplateBodyDto,
  ): Promise<{ text: string }> {
    const template = await this.templates.require(auth.tenantId, id);
    return { text: render(template.body, body.values) };
  }

  @Post()
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Add a template or canned reply',
    description:
      'A `whatsapp_template` is recorded as **pending**, never approved: its `name` and `language` must match a template already approved in your WhatsApp Business account, and we do not take your word for that — a sync reconciles it, and until then a send outside the window is refused rather than attempted.\n\nA `canned_reply` needs no review and is usable immediately, but only inside the 24-hour window.',
  })
  @ApiCreatedResponse({ type: TemplateRecordDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 409,
    description: 'That name already exists in that language.',
    type: ApiErrorDto,
  })
  create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createTemplateBodySchema))
    body: CreateTemplateBodyDto,
  ): Promise<MessageTemplateRecord> {
    return wrapBodyErrors(() =>
      this.templates.create(auth.tenantId, {
        kind: body.kind,
        name: body.name,
        language: body.language,
        category: body.category,
        body: body.body,
        variables: body.variables,
      }),
    );
  }

  @Patch(':id')
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Edit a template',
    description:
      "Editing an approved WhatsApp template's **body** puts it back to `pending`, because Meta approved specific words and sending different ones under an approved name is what gets a business account flagged. Re-submit it in WhatsApp Manager, then sync.\n\n`name`, `language` and `kind` are not editable — they are the identity Meta knows the template by. Create a new one instead.",
  })
  @ApiParam(TEMPLATE_ID_PARAM)
  @ApiOkResponse({ type: TemplateRecordDto })
  @ApiValidationErrorResponse()
  @ApiResponse(NOT_FOUND)
  update(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateTemplateBodySchema))
    body: UpdateTemplateBodyDto,
  ): Promise<MessageTemplateRecord> {
    return wrapBodyErrors(() => this.templates.update(auth.tenantId, id, body));
  }

  @Delete(':id')
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Delete a template',
    description:
      'Removes it from this workspace only. A WhatsApp template stays registered with Meta until it is deleted in WhatsApp Manager too — deleting here just means nobody can pick it.',
  })
  @ApiParam(TEMPLATE_ID_PARAM)
  @ApiOkResponse({ description: 'Deleted.' })
  @ApiResponse(NOT_FOUND)
  async remove(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.templates.remove(auth.tenantId, id);
    return { ok: true };
  }
}

/** A malformed body or a wrong value count is the caller's mistake, so it is a 400 rather than the 500 an unmapped domain error would produce. */
async function wrapBodyErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TemplateBodyError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

function render(body: string, values: string[]): string {
  try {
    return renderTemplateBody(body, values);
  } catch (error) {
    if (error instanceof TemplateBodyError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}
