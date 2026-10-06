// Gulf T8 (F23): the tenant rules API contract (Zod -> OpenAPI via nestjs-zod,
// like every other controller here).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  COMMENT_ACTIONS,
  COMMENT_ACTION_STATUSES,
  COMMENT_DECISIONS,
  COMMENT_EVENT_STATUSES,
  COMMENT_POST_SCOPES,
  COMMENT_REPLY_INTENTS,
  COMMENT_THREAD_STATES,
} from '../persistence/drizzle/schema';

export const MAX_KEYWORDS = 50;
export const MAX_KEYWORD_LENGTH = 60;
export const MAX_TEMPLATE_LENGTH = 500;
export const MAX_POST_CAP = 200;
export const MAX_TENANT_CAP = 2000;

const keywordList = z
  .array(z.string().trim().min(1).max(MAX_KEYWORD_LENGTH))
  .max(MAX_KEYWORDS)
  // Case-insensitive de-duplication, keeping the first spelling given.
  .transform((keywords) =>
    keywords.filter(
      (keyword, index) =>
        keywords.findIndex(
          (other) => other.toLowerCase() === keyword.toLowerCase(),
        ) === index,
    ),
  );

const template = z.string().trim().min(1).max(MAX_TEMPLATE_LENGTH);

export const commentAutomationSettingsBodySchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'Master switch. Off by default: nothing is posted until the tenant turns it on.',
    ),
  postScope: z
    .enum(COMMENT_POST_SCOPES)
    .describe(
      '`all`: every post except those disabled with a post rule. `selected`: only posts enabled with a post rule.',
    ),
  replyIntents: z
    .array(z.enum(COMMENT_REPLY_INTENTS))
    .max(COMMENT_REPLY_INTENTS.length)
    .transform((intents) => [...new Set(intents)])
    .describe(
      'Classified intents that get a public + private reply. Empty = only keyword triggers are answered.',
    ),
  keywordTriggers: keywordList.describe(
    'A comment containing any of these (case- and Arabic-spelling-insensitive) is answered without the classifier, e.g. "price", "بكم".',
  ),
  spamKeywords: keywordList.describe(
    'A comment containing any of these is treated as spam: hidden when `hideSpam`, never answered. Checked before triggers.',
  ),
  hideSpam: z
    .boolean()
    .describe('Hide comments classified (or matched) as spam or abuse.'),
  publicReplyTemplate: template.describe(
    'Posted publicly under the comment after the private reply is sent, e.g. "Sent you the details in DM".',
  ),
  hourlyReplyCapPerPost: z.number().int().min(1).max(MAX_POST_CAP),
  hourlyReplyCapPerTenant: z.number().int().min(1).max(MAX_TENANT_CAP),
});
export class CommentAutomationSettingsBodyDto extends createZodDto(
  commentAutomationSettingsBodySchema,
) {}
export type CommentAutomationSettingsInput = z.infer<
  typeof commentAutomationSettingsBodySchema
>;

export const commentAutomationSettingsSchema =
  commentAutomationSettingsBodySchema.extend({
    updatedAt: isoTimestamp()
      .nullable()
      .describe(
        'Null while the tenant has never saved settings (defaults shown).',
      ),
  });
export class CommentAutomationSettingsDto extends createZodDto(
  commentAutomationSettingsSchema,
) {}

export const commentPostRuleBodySchema = z.object({
  channelAccountId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      'A connected Facebook page id or Instagram account id (`GET /channels/meta` `channelAccountId`).',
    ),
  postId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe(
      'Facebook post id (`{page-id}_{post-id}`) or Instagram media id.',
    ),
  enabled: z.boolean(),
  publicReplyTemplate: template
    .nullable()
    .describe(
      'Overrides the workspace template for this post. Null = use the workspace template.',
    ),
});
export class CommentPostRuleBodyDto extends createZodDto(
  commentPostRuleBodySchema,
) {}
export type CommentPostRuleInput = z.infer<typeof commentPostRuleBodySchema>;

export const commentPostRuleSchema = z.object({
  id: z.string().uuid(),
  channel: z.enum(['messenger', 'instagram']),
  channelAccountId: z.string(),
  postId: z.string(),
  enabled: z.boolean(),
  publicReplyTemplate: z.string().nullable(),
  updatedAt: isoTimestamp(),
});
export class CommentPostRuleDto extends createZodDto(commentPostRuleSchema) {}
export class CommentPostRuleListDto extends createZodDto(
  z.array(commentPostRuleSchema),
) {}

export const commentActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const commentActivitySchema = z.object({
  id: z.string().uuid(),
  channel: z.enum(['messenger', 'instagram']),
  channelAccountId: z.string(),
  postId: z.string(),
  commentId: z.string(),
  authorName: z.string().nullable(),
  text: z.string(),
  status: z.enum(COMMENT_EVENT_STATUSES),
  skipReason: z.string().nullable(),
  intent: z.string().nullable(),
  decision: z.enum(COMMENT_DECISIONS).nullable(),
  threadState: z.enum(COMMENT_THREAD_STATES).nullable(),
  conversationId: z.string().uuid().nullable(),
  actions: z.array(
    z.object({
      action: z.enum(COMMENT_ACTIONS),
      status: z.enum(COMMENT_ACTION_STATUSES),
    }),
  ),
  createdAt: isoTimestamp(),
});
export class CommentActivityListDto extends createZodDto(
  z.array(commentActivitySchema),
) {}
