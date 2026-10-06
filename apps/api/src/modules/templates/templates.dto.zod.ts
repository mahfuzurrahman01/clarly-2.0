// Product shell (TemplatesModule, F12): request/response contract for the
// template library. Zod via nestjs-zod, matching the rest of the console API.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  TEMPLATE_APPROVAL_STATUSES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_KINDS,
} from '../persistence/drizzle/schema';
import { isoTimestamp } from '../../common/iso-timestamp';

/**
 * Meta's own constraint on a template name: lowercase letters, digits and
 * underscores. Enforced here rather than at send time because the name is the
 * only thing linking our row to the one Meta approved, and a mismatched name
 * fails as "template not found" with no hint at which end is wrong.
 */
const whatsappNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[a-z0-9_]+$/,
    'A WhatsApp template name may only contain lowercase letters, digits and underscores — it has to match the name approved in your WhatsApp Business account exactly.',
  );

const cannedNameSchema = z.string().trim().min(1).max(512);

const languageSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .default('en')
  .describe(
    'Meta language code (`en`, `en_US`, `bn`). Meta treats one template name in two languages as two templates.',
  );

const variableSchema = z.object({
  position: z
    .number()
    .int()
    .min(1)
    .describe('1-based, matching the `{{n}}` it fills.'),
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      'What the console asks a person for. `{{2}}` on its own tells them nothing.',
    ),
  example: z.string().trim().max(500).nullable().default(null),
});

const bodySchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe(
    'The message text, with `{{1}}`-style positional placeholders. Placeholders must run consecutively from {{1}}; Meta rejects gaps, and it does so at send time rather than here.',
  );

export const createTemplateBodySchema = z
  .object({
    kind: z
      .enum(TEMPLATE_KINDS)
      .describe(
        "'whatsapp_template' is pre-registered with Meta and is the only thing that sends outside the 24-hour window. 'canned_reply' is your own saved text and only sends inside it.",
      ),
    name: z.string().trim().min(1).max(512),
    language: languageSchema,
    category: z.enum(TEMPLATE_CATEGORIES).nullable().default(null),
    body: bodySchema,
    variables: z.array(variableSchema).max(20).default([]),
  })
  // Applied after the fact rather than as a discriminated union so the error
  // points at `name` with Meta's actual rule, instead of at the union.
  .superRefine((value, ctx) => {
    if (value.kind !== 'whatsapp_template') return;

    const parsed = whatsappNameSchema.safeParse(value.name);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: parsed.error.issues[0].message,
      });
    }
    if (!value.category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message:
          'A WhatsApp template needs the category it was submitted to Meta under.',
      });
    }
  });

export type CreateTemplateBody = z.infer<typeof createTemplateBodySchema>;
export class CreateTemplateBodyDto extends createZodDto(
  createTemplateBodySchema,
) {}

/**
 * Name, language and kind are absent on purpose: they are the identity Meta
 * knows a template by. Changing one is creating a different template, and
 * silently repointing an approved name at different content is what gets a
 * WABA flagged.
 */
export const updateTemplateBodySchema = z
  .object({
    name: cannedNameSchema.optional(),
    category: z.enum(TEMPLATE_CATEGORIES).nullable().optional(),
    body: bodySchema.optional(),
    variables: z.array(variableSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update.',
  });

export type UpdateTemplateBody = z.infer<typeof updateTemplateBodySchema>;
export class UpdateTemplateBodyDto extends createZodDto(
  updateTemplateBodySchema,
) {}

export const listTemplatesQuerySchema = z.object({
  kind: z.enum(TEMPLATE_KINDS).optional().describe('Omit for both kinds.'),
});

export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;
export class ListTemplatesQueryDto extends createZodDto(
  listTemplatesQuerySchema,
) {}

export const previewTemplateBodySchema = z.object({
  values: z
    .array(z.string().max(1000))
    .max(20)
    .describe(
      'One value per placeholder, in position order. A count that does not match the template is rejected rather than blank-filled.',
    ),
});

export type PreviewTemplateBody = z.infer<typeof previewTemplateBodySchema>;
export class PreviewTemplateBodyDto extends createZodDto(
  previewTemplateBodySchema,
) {}

export const templateRecordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string(),
  language: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES).nullable(),
  body: z.string(),
  variables: z.array(
    z.object({
      position: z.number().int(),
      label: z.string(),
      example: z.string().nullable(),
    }),
  ),
  approvalStatus: z
    .enum(TEMPLATE_APPROVAL_STATUSES)
    .describe(
      "'local' is a canned reply, which needs no review. Only 'approved' will send outside the 24-hour window — everything else is refused before it reaches Meta.",
    ),
  approvalDetail: z
    .string()
    .nullable()
    .describe("Meta's own words on a rejection, unparaphrased."),
  syncedAt: isoTimestamp()
    .nullable()
    .describe(
      'When the status was last reconciled with the BSP. Null means never — the status is what you told us, not what Meta says.',
    ),
  createdAt: isoTimestamp(),
  updatedAt: isoTimestamp(),
});

export class TemplateRecordDto extends createZodDto(templateRecordSchema) {}
export class TemplateListDto extends createZodDto(
  z.array(templateRecordSchema),
) {}

export const templatePreviewSchema = z.object({
  text: z
    .string()
    .describe(
      'The body with values filled in — exactly what the customer will read.',
    ),
});

export class TemplatePreviewDto extends createZodDto(templatePreviewSchema) {}

export const templateSyncResultSchema = z.object({
  updated: z.number().int().describe('How many stored statuses changed.'),
  unknownToBsp: z
    .array(z.string())
    .describe(
      'Templates stored here that your WhatsApp Business account has never heard of — almost always a name typed differently at one end. These are left untouched, not deleted.',
    ),
  unreported: z
    .boolean()
    .describe(
      'True when no connected number could report at all — nothing was reconciled and nothing was changed. Distinct from "you have no templates", which would otherwise look identical and wrongly invalidate every approved one.',
    ),
});

export class TemplateSyncResultDto extends createZodDto(
  templateSyncResultSchema,
) {}

export const templateSubmissionResultSchema = z.object({
  submitted: z
    .boolean()
    .describe(
      'True when a WhatsApp Business account accepted the template for review. False means nothing was sent and the stored status is unchanged — check `unsupportedReason`.',
    ),
  providerTemplateId: z
    .string()
    .nullable()
    .describe(
      'The id WhatsApp issued for the template, when it issued one. Keep it: appealing a rejection needs it.',
    ),
  unsupportedReason: z
    .string()
    .nullable()
    .describe(
      'Set only when `submitted` is false — why no connected number could register the template. Null on success.',
    ),
});

export class TemplateSubmissionResultDto extends createZodDto(
  templateSubmissionResultSchema,
) {}
