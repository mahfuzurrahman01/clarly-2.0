// Gulf T8 (F23): the tenant's comment-automation rules — reads, writes, and
// the effective rules for one post that the pipeline runs with.
import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
  commentAutomationSettings,
  commentPostRules,
  type CommentPostScope,
  type CommentReplyIntent,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { SocialChannelDirectory } from '../meta-channel/social-channel-directory.service';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { CommentChannelNotConnectedError } from './comment.errors';
import type {
  CommentAutomationSettingsInput,
  CommentPostRuleInput,
} from './comment-rules.dto';

export interface CommentAutomationSettingsRecord {
  enabled: boolean;
  postScope: CommentPostScope;
  replyIntents: CommentReplyIntent[];
  keywordTriggers: string[];
  spamKeywords: string[];
  hideSpam: boolean;
  publicReplyTemplate: string;
  hourlyReplyCapPerPost: number;
  hourlyReplyCapPerTenant: number;
  updatedAt: Date | null;
}

export interface CommentPostRuleRecord {
  id: string;
  channel: ChannelKind;
  channelAccountId: string;
  postId: string;
  enabled: boolean;
  publicReplyTemplate: string | null;
  updatedAt: Date;
}

/** What the pipeline runs one comment with: the tenant settings, resolved for its post. */
export interface EffectiveCommentRules extends CommentAutomationSettingsRecord {
  /** Automation is on for this tenant AND this post. */
  active: boolean;
}

export const DEFAULT_PUBLIC_REPLY_TEMPLATE =
  "Thanks for your comment! We've sent you the details in a private message.";

/** A tenant that never saved settings: automation OFF, everything else sensible. */
export const DEFAULT_COMMENT_SETTINGS: CommentAutomationSettingsRecord = {
  enabled: false,
  postScope: 'all',
  replyIntents: ['purchase', 'question'],
  keywordTriggers: [],
  spamKeywords: [],
  hideSpam: true,
  publicReplyTemplate: DEFAULT_PUBLIC_REPLY_TEMPLATE,
  hourlyReplyCapPerPost: 30,
  hourlyReplyCapPerTenant: 200,
  updatedAt: null,
};

@Injectable()
export class CommentRulesService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly socialChannels: SocialChannelDirectory,
  ) {}

  async getSettings(
    tenantId: string,
  ): Promise<CommentAutomationSettingsRecord> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(commentAutomationSettings)
          .where(eq(commentAutomationSettings.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toSettings(rows[0]) : DEFAULT_COMMENT_SETTINGS;
  }

  async putSettings(
    tenantId: string,
    userId: string,
    input: CommentAutomationSettingsInput,
  ): Promise<CommentAutomationSettingsRecord> {
    const now = new Date();
    const values = { ...input, updatedBy: userId, updatedAt: now };
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(commentAutomationSettings)
          .values({ tenantId, ...values })
          .onConflictDoUpdate({
            target: commentAutomationSettings.tenantId,
            set: values,
          })
          .returning(),
      tenantId,
    );
    return toSettings(row);
  }

  async listPostRules(tenantId: string): Promise<CommentPostRuleRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(commentPostRules)
          .where(eq(commentPostRules.tenantId, tenantId))
          .orderBy(asc(commentPostRules.createdAt)),
      tenantId,
    );
    return rows.map(toPostRule);
  }

  /**
   * Upserts the rule for (account, post).
   *
   * @throws CommentChannelNotConnectedError when the account is not one of
   *   this workspace's connected social channels — the rule would otherwise
   *   name another tenant's page, or nothing at all.
   */
  async upsertPostRule(
    tenantId: string,
    userId: string,
    input: CommentPostRuleInput,
  ): Promise<CommentPostRuleRecord> {
    const connected = await this.socialChannels.listForTenant(tenantId);
    const account = connected.find(
      (channel) => channel.channelAccountId === input.channelAccountId,
    );
    if (!account) {
      throw new CommentChannelNotConnectedError(input.channelAccountId);
    }

    const now = new Date();
    const values = {
      enabled: input.enabled,
      publicReplyTemplate: input.publicReplyTemplate,
      updatedBy: userId,
      updatedAt: now,
    };
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(commentPostRules)
          .values({
            tenantId,
            channel: account.channel,
            channelAccountId: input.channelAccountId,
            postId: input.postId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [
              commentPostRules.tenantId,
              commentPostRules.channelAccountId,
              commentPostRules.postId,
            ],
            set: values,
          })
          .returning(),
      tenantId,
    );
    return toPostRule(row);
  }

  /** False when nothing matched — unknown id, or another tenant's (RLS makes them the same). */
  async deletePostRule(tenantId: string, id: string): Promise<boolean> {
    const deleted = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .delete(commentPostRules)
          .where(
            and(
              eq(commentPostRules.tenantId, tenantId),
              eq(commentPostRules.id, id),
            ),
          )
          .returning({ id: commentPostRules.id }),
      tenantId,
    );
    return deleted.length > 0;
  }

  async resolveForPost(
    tenantId: string,
    channelAccountId: string,
    postId: string,
  ): Promise<EffectiveCommentRules> {
    const settings = await this.getSettings(tenantId);
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(commentPostRules)
          .where(
            and(
              eq(commentPostRules.tenantId, tenantId),
              eq(commentPostRules.channelAccountId, channelAccountId),
              eq(commentPostRules.postId, postId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return effectiveRules(settings, rows[0] ? toPostRule(rows[0]) : null);
  }
}

/** Pure: settings + an optional post rule -> the rules one comment runs with. */
export function effectiveRules(
  settings: CommentAutomationSettingsRecord,
  postRule: Pick<
    CommentPostRuleRecord,
    'enabled' | 'publicReplyTemplate'
  > | null,
): EffectiveCommentRules {
  const postEnabled =
    settings.postScope === 'selected'
      ? postRule?.enabled === true
      : postRule?.enabled !== false;
  return {
    ...settings,
    publicReplyTemplate:
      postRule?.publicReplyTemplate ?? settings.publicReplyTemplate,
    active: settings.enabled && postEnabled,
  };
}

function toSettings(
  row: typeof commentAutomationSettings.$inferSelect,
): CommentAutomationSettingsRecord {
  return {
    enabled: row.enabled,
    postScope: row.postScope,
    replyIntents: row.replyIntents,
    keywordTriggers: row.keywordTriggers,
    spamKeywords: row.spamKeywords,
    hideSpam: row.hideSpam,
    publicReplyTemplate: row.publicReplyTemplate,
    hourlyReplyCapPerPost: row.hourlyReplyCapPerPost,
    hourlyReplyCapPerTenant: row.hourlyReplyCapPerTenant,
    updatedAt: row.updatedAt,
  };
}

function toPostRule(
  row: typeof commentPostRules.$inferSelect,
): CommentPostRuleRecord {
  return {
    id: row.id,
    channel: row.channel,
    channelAccountId: row.channelAccountId,
    postId: row.postId,
    enabled: row.enabled,
    publicReplyTemplate: row.publicReplyTemplate,
    updatedAt: row.updatedAt,
  };
}
