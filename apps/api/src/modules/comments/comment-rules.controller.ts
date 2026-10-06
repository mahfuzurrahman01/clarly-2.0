// Gulf T8 (F23): the tenant rules API behind the console's comment-automation
// settings. Admin-only, like every other tenant-configuration surface: these
// rules decide what gets posted publicly under the tenant's brand.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CommentLedgerService } from './comment-ledger.service';
import {
  CommentActivityListDto,
  commentActivityQuerySchema,
  CommentAutomationSettingsBodyDto,
  commentAutomationSettingsBodySchema,
  CommentAutomationSettingsDto,
  CommentPostRuleBodyDto,
  commentPostRuleBodySchema,
  CommentPostRuleDto,
  CommentPostRuleListDto,
} from './comment-rules.dto';
import {
  CommentRulesService,
  type CommentAutomationSettingsRecord,
  type CommentPostRuleRecord,
} from './comment-rules.service';
import { CommentChannelNotConnectedError } from './comment.errors';

@ApiTags('comment-automation')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('comment-automation')
@UseGuards(RolesGuard)
@Roles('admin')
export class CommentRulesController {
  constructor(
    private readonly rules: CommentRulesService,
    private readonly ledger: CommentLedgerService,
  ) {}

  @Get('settings')
  @ApiOperation({
    summary: 'Read the comment-automation settings',
    description:
      'The workspace defaults are returned (with `updatedAt: null`) until settings are saved. Automation is off by default.',
  })
  @ApiOkResponse({ type: CommentAutomationSettingsDto })
  async getSettings(@CurrentAuth() auth: TenantAuthContext) {
    return serializeSettings(await this.rules.getSettings(auth.tenantId));
  }

  @Put('settings')
  @ApiOperation({
    summary: 'Replace the comment-automation settings',
    description: 'Full replacement: send every field.',
  })
  @ApiOkResponse({ type: CommentAutomationSettingsDto })
  @ApiValidationErrorResponse()
  async putSettings(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(commentAutomationSettingsBodySchema))
    body: CommentAutomationSettingsBodyDto,
  ) {
    return serializeSettings(
      await this.rules.putSettings(auth.tenantId, auth.userId, body),
    );
  }

  @Get('posts')
  @ApiOperation({ summary: 'List per-post rules' })
  @ApiOkResponse({ type: CommentPostRuleListDto })
  async listPosts(@CurrentAuth() auth: TenantAuthContext) {
    const rules = await this.rules.listPostRules(auth.tenantId);
    return rules.map(serializePostRule);
  }

  @Put('posts')
  @ApiOperation({
    summary: 'Enable/disable one post, or set its public reply template',
    description:
      "Upsert keyed by (channelAccountId, postId). `channelAccountId` must be one of this workspace's connected Facebook pages or Instagram accounts.",
  })
  @ApiOkResponse({ type: CommentPostRuleDto })
  @ApiValidationErrorResponse()
  @ApiNotFoundResponse({
    description: 'The channel account is not connected to this workspace.',
    type: ApiErrorDto,
  })
  async upsertPost(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(commentPostRuleBodySchema))
    body: CommentPostRuleBodyDto,
  ) {
    try {
      return serializePostRule(
        await this.rules.upsertPostRule(auth.tenantId, auth.userId, body),
      );
    } catch (error) {
      if (error instanceof CommentChannelNotConnectedError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Delete('posts/:id')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Remove a per-post rule (the post falls back to the workspace scope)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async deletePost(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    if (!(await this.rules.deletePostRule(auth.tenantId, id))) {
      throw new NotFoundException('Post rule not found');
    }
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Recent comments the automation handled',
    description:
      'Newest first: what each comment was classified as, what was decided, what was done on Meta, and the private-reply thread state.',
  })
  @ApiOkResponse({ type: CommentActivityListDto })
  @ApiValidationErrorResponse()
  async activity(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(commentActivityQuerySchema))
    query: { limit: number },
  ) {
    const rows = await this.ledger.listRecent(auth.tenantId, query.limit);
    return rows.map(({ event, actions }) => ({
      id: event.id,
      channel: event.channel,
      channelAccountId: event.channelAccountId,
      postId: event.postId,
      commentId: event.commentId,
      authorName: event.authorName,
      text: event.text,
      status: event.status,
      skipReason: event.skipReason,
      intent: event.intent,
      decision: event.decision,
      threadState: event.threadState,
      conversationId: event.conversationId,
      actions: actions.map((action) => ({
        action: action.action,
        status: action.status,
      })),
      createdAt: event.createdAt.toISOString(),
    }));
  }
}

function serializeSettings(settings: CommentAutomationSettingsRecord) {
  return { ...settings, updatedAt: settings.updatedAt?.toISOString() ?? null };
}

function serializePostRule(rule: CommentPostRuleRecord) {
  return { ...rule, updatedAt: rule.updatedAt.toISOString() };
}
