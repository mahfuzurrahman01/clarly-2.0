// Product shell (AgentConfigModule, F9): the tenant-facing configuration
// contract — and, because F9 renders prompts from structured fields rather
// than accepting prose, this schema IS the boundary of what a tenant can
// express about their agent.
//
// Caps are not cosmetic. Every field below is rendered into L1/L2 of a
// prompt whose remaining budget is shared with retrieved KB content, so an
// unbounded persona is an unbounded prompt: it crowds out the retrieved
// chunks the answer is supposed to be grounded in. They match the existing
// L1 cap (`sanitizeTenantPersona`, 500 chars) rather than inventing new
// limits.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AGENT_TONES } from '../persistence/drizzle/agent-versions.table';
import { OPTIONAL_ESCALATION_TRIGGERS } from '../persistence/drizzle/agent-versions.table';
import { AGENT_STATUSES } from '../persistence/drizzle/agents.table';
import { isoTimestamp } from '../../common/iso-timestamp';
import { WEEKDAYS } from './business-hours';
import {
  findBlockedTerm,
  INTAKE_FIELD_TYPES,
  INTAKE_SCOPES,
  MAX_INTAKE_FIELDS,
} from './intake-fields';

/** Trimmed, and empty string normalized to null: a cleared textarea means "no value", not "a value that is blank". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

const CLOCK_TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

const dayHoursSchema = z
  .object({
    open: z.string().regex(CLOCK_TIME, 'Use HH:MM, e.g. 09:00'),
    close: z.string().regex(CLOCK_TIME, 'Use HH:MM, e.g. 17:00'),
  })
  .refine((day) => day.close > day.open, {
    message: 'Closing time must be after opening time.',
  });

/** Keyed by weekday; a missing day is closed. Rejected rather than coerced, because a typo here silently changes when a tenant is reachable. */
export const businessHoursSchema = z.object(
  Object.fromEntries(
    WEEKDAYS.map((weekday) => [weekday, dayHoursSchema.optional()]),
  ) as Record<(typeof WEEKDAYS)[number], z.ZodOptional<typeof dayHoursSchema>>,
);

/** Keys are used verbatim as tool-argument names and column values, so they stay machine-shaped; the label is what a customer effectively hears. */
const intakeFieldSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'Use lower-case letters, numbers and underscores, starting with a letter.',
      ),
    label: z.string().trim().min(1).max(80),
    type: z.enum(INTAKE_FIELD_TYPES),
    required: z.boolean().default(false),
    choices: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
    scope: z.enum(INTAKE_SCOPES).default('conversation'),
  })
  .refine(
    (field) => field.type !== 'choice' || (field.choices?.length ?? 0) > 0,
    { message: 'A choice field needs at least one option.', path: ['choices'] },
  )
  .refine((field) => findBlockedTerm(field.key, field.label) === null, {
    // L0 refuses to store card numbers, OTPs and national ID numbers. An
    // intake field must not become the way around that.
    message:
      'That field asks for sensitive data this platform will not collect over WhatsApp.',
    path: ['label'],
  });

export const agentConfigSchema = z.object({
  intakeFields: z
    .array(intakeFieldSchema)
    .max(MAX_INTAKE_FIELDS)
    .optional()
    .describe(
      'What the agent should collect from customers. Capped: every field is prompt text competing with retrieved knowledge, and an agent working through a dozen questions is a form with a chat interface.',
    ),
  roleDescription: optionalText(300).describe(
    'What this agent handles: "order and delivery questions for a clothing brand".',
  ),
  persona: optionalText(500).describe('Voice and character of the replies.'),
  tone: z.enum(AGENT_TONES).nullable().optional(),
  languages: z
    .array(z.string().trim().min(1).max(40))
    .max(10)
    .optional()
    .describe(
      'Languages this agent should reply in. Leave empty to keep the platform default: reply in whatever language the customer wrote in.',
    ),
  greeting: optionalText(200),
  outOfScopeResponse: optionalText(300).describe(
    'Wording used when the knowledge base does not cover the question. The agent still escalates either way — this only changes what the customer reads.',
  ),
  forbiddenTopics: z
    .array(z.string().trim().min(1).max(80))
    .max(50)
    .optional()
    .describe(
      'Enforced deterministically at intake by the guardrail check, not by prompt wording.',
    ),
  businessHours: businessHoursSchema
    .nullable()
    .optional()
    .describe(
      'Opening hours per weekday, as local `HH:MM` times in `timezone`. A weekday with no entry is closed. Null or empty means always open, which is what every agent did before this existed.',
    ),
  timezone: optionalText(64).describe(
    'IANA zone, required for business hours to mean anything.',
  ),
  outOfHoursResponse: optionalText(300),
  escalationTriggers: z
    .array(z.enum(OPTIONAL_ESCALATION_TRIGGERS))
    .max(OPTIONAL_ESCALATION_TRIGGERS.length)
    .optional()
    .describe(
      'ADDITIONAL triggers only. Distress, sensitive data, knowledge-base conflicts and uncovered questions always escalate and cannot be switched off here.',
    ),
  confidenceThreshold: z.coerce.number().min(0).max(1).optional(),
  rerankEnabled: z.boolean().optional(),
  stuckTicketThresholdMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional(),
  handoverAutoReturnMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(1440)
    .optional()
    .describe(
      'How long a human handover survives without being handed back. Floored at 5 minutes: shorter and the agent would talk over a person mid-conversation, which is the failure handover exists to prevent.',
    ),
  maxToolCallsPerTurn: z.coerce.number().int().min(0).max(10).optional(),
});

export type AgentConfigInput = z.infer<typeof agentConfigSchema>;

export const createAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Optional initial configuration, so creating an agent and describing it is one call rather than two. */
  config: agentConfigSchema.optional(),
});

export type CreateAgentBody = z.infer<typeof createAgentBodySchema>;
export class CreateAgentBodyDto extends createZodDto(createAgentBodySchema) {}

export const updateAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: agentConfigSchema.optional(),
  /**
   * Which WhatsApp number this agent answers on. `null` unbinds it.
   *
   * Not part of `config`: a binding is not versioned. Rolling back to an
   * older configuration must not silently move a live number to a different
   * agent — routing is a decision about now, not a property of a draft.
   */
  whatsappNumberId: z.string().uuid().nullable().optional(),
});

export type UpdateAgentBody = z.infer<typeof updateAgentBodySchema>;
export class UpdateAgentBodyDto extends createZodDto(updateAgentBodySchema) {}

const agentConfigResponseSchema = agentConfigSchema.extend({
  roleDescription: z.string().nullable(),
  persona: z.string().nullable(),
  tone: z.enum(AGENT_TONES).nullable(),
  languages: z.array(z.string()),
  greeting: z.string().nullable(),
  outOfScopeResponse: z.string().nullable(),
  forbiddenTopics: z.array(z.string()),
  businessHours: businessHoursSchema.nullable(),
  intakeFields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(INTAKE_FIELD_TYPES),
      required: z.boolean(),
      choices: z.array(z.string()).optional(),
      scope: z.enum(INTAKE_SCOPES),
    }),
  ),
  timezone: z.string().nullable(),
  outOfHoursResponse: z.string().nullable(),
  escalationTriggers: z.array(z.enum(OPTIONAL_ESCALATION_TRIGGERS)),
  confidenceThreshold: z.number(),
  rerankEnabled: z.boolean(),
  stuckTicketThresholdMinutes: z.number().int(),
  handoverAutoReturnMinutes: z.number().int(),
  maxToolCallsPerTurn: z.number().int(),
});

export const agentRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(AGENT_STATUSES),
  whatsappNumberId: z.string().uuid().nullable(),
  /** Version currently answering customers. Null until first publish. */
  publishedVersion: z.number().int().nullable(),
  /** True when there are edits not yet published. */
  hasUnpublishedChanges: z.boolean(),
  /**
   * The configuration to SHOW: the draft when one exists, otherwise the
   * published version. A console that displayed the published values while a
   * draft existed would silently discard the tenant's unsaved intent.
   */
  config: agentConfigResponseSchema.nullable(),
  createdAt: isoTimestamp(),
  updatedAt: isoTimestamp(),
});

export type AgentRecord = z.infer<typeof agentRecordSchema>;
export class AgentRecordDto extends createZodDto(agentRecordSchema) {}
export class AgentListDto extends createZodDto(z.array(agentRecordSchema)) {}

export const sandboxBodySchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What a customer would send.'),
});

export type SandboxBody = z.infer<typeof sandboxBodySchema>;
export class SandboxBodyDto extends createZodDto(sandboxBodySchema) {}

export const sandboxResultSchema = z.object({
  answer: z.string(),
  citedChunkIds: z
    .array(z.string())
    .describe(
      'Knowledge-base chunks the answer was drawn from. Empty means the agent answered without the knowledge base — for anything factual, that is itself the finding.',
    ),
  confidence: z.number(),
  escalate: z.boolean(),
  escalationReason: z.string().nullable(),
  testedVersion: z
    .enum(['draft', 'published'])
    .describe(
      'Which configuration answered. The draft wins when one exists — testing what you just edited is the point.',
    ),
  latencyMs: z.number().int(),
});

export class SandboxResultDto extends createZodDto(sandboxResultSchema) {}

export const knowledgeScopeSchema = z.object({
  scopedToAll: z
    .boolean()
    .describe(
      'True when no documents are selected, which means the agent may use the whole knowledge base — not that it may use none.',
    ),
  documents: z.array(
    z.object({
      id: z.string().uuid(),
      filename: z.string(),
      selected: z.boolean(),
    }),
  ),
});

export class KnowledgeScopeDto extends createZodDto(knowledgeScopeSchema) {}

export const setKnowledgeScopeBodySchema = z.object({
  documentIds: z
    .array(z.string().uuid())
    .describe(
      'Documents this agent may answer from. An EMPTY array means the whole knowledge base, not none.',
    ),
});

export type SetKnowledgeScopeBody = z.infer<typeof setKnowledgeScopeBodySchema>;
export class SetKnowledgeScopeBodyDto extends createZodDto(
  setKnowledgeScopeBodySchema,
) {}

export const whatsappNumberSchema = z.object({
  id: z.string().uuid(),
  /** The BSP's id for the number. Shown so an operator can match it against the BSP console; credentials are never exposed. */
  phoneNumberId: z.string(),
  /** The agent currently answering on it, if any — what makes "already in use" visible before a 409. */
  boundAgentId: z.string().uuid().nullable(),
});

export type WhatsappNumberOption = z.infer<typeof whatsappNumberSchema>;
export class WhatsappNumberListDto extends createZodDto(
  z.array(whatsappNumberSchema),
) {}

export const agentVersionSummarySchema = z.object({
  version: z.number().int(),
  publishedAt: isoTimestamp().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: isoTimestamp(),
  config: agentConfigResponseSchema,
});

export type AgentVersionSummary = z.infer<typeof agentVersionSummarySchema>;
export class AgentVersionListDto extends createZodDto(
  z.array(agentVersionSummarySchema),
) {}
