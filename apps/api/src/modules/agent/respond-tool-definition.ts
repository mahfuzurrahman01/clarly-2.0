// A4/D11: the reserved terminal tool every agent turn must call to end.
// Platform-level — unlike L3's tenant tool schemas (ToolRegistryModule),
// this is not something a tenant enables/disables; AgentRuntime always
// appends it to whatever tools PromptAssemblyService/ToolRegistryModule
// produced for a turn. Its JSON schema is hand-authored to match
// GuardrailModule's RespondPayloadSchema (Zod) field-for-field — same
// "shared source of truth" spirit as A2's tool-definitions.ts pairing a
// Zod schema with a hand-matched JSON schema, just without a shared object
// this time since RespondPayloadSchema lives in a different module
// (GuardrailModule) than the tool-call boundary (AgentModule) and D11's
// contract is stable enough not to need it.
import type { LlmToolDefinition } from '../llm/ports/llm-provider.port';
import { ESCALATION_REASONS } from '@repo/errors';

export const RESPOND_TOOL_NAME = 'respond';

/**
 * D13: the reasons the MODEL may name for itself. The three excluded ones
 * (all added 2026-08-17) are decided by code the model cannot observe or must
 * not pre-empt: `DELIVERY_FAILURE` (an outbound send that has not happened
 * yet), `JOB_FAILURE` (a crash that would prevent this call from existing),
 * and `KB_CONFLICT` (the grounding check's verdict, which exists precisely
 * because the model does not notice the conflict on its own — offering it
 * would let a turn self-label a conflict it then answered anyway). Every other reason
 * stays offered: narrowing this list further would change measured behaviour
 * mid-certification, which is a separate, eval-gated change.
 */
const NEVER_MODEL_SELECTABLE = [
  'DELIVERY_FAILURE',
  'JOB_FAILURE',
  'KB_CONFLICT',
] as const;

const MODEL_SELECTABLE_REASONS = ESCALATION_REASONS.filter(
  (reason) => !(NEVER_MODEL_SELECTABLE as readonly string[]).includes(reason),
);

/**
 * F10: values the turn captured, keyed by the tenant's own field keys.
 *
 * Carried here rather than on a `record_intake` tool of its own: the loop is
 * bounded at MAX_TOOL_ROUND_TRIPS, and spending a round trip on bookkeeping
 * risks a turn hitting the cap and escalating for no reason. Reporting
 * capture alongside the answer costs no extra call and no new loop branch.
 */
const INTAKE_PROPERTY = {
  type: 'array',
  description:
    'Values you collected from the customer, one entry per field named in "Information to collect". Include a field as soon as the customer has given it, even if they gave it in an earlier message. Omit the array entirely when you have collected nothing. Never invent a value the customer did not give.',
  items: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'The field key, exactly as listed.',
      },
      value: { type: 'string', description: "The customer's own value." },
    },
    required: ['key', 'value'],
  },
} as const;

export const RESPOND_TOOL_DEFINITION: LlmToolDefinition = {
  name: RESPOND_TOOL_NAME,
  description:
    'Call this to end your turn. Always call this exactly once, as your final action, whether you are answering normally or escalating to a human.',
  inputSchema: {
    type: 'object',
    properties: {
      answer: { type: 'string', minLength: 1 },
      cited_chunk_ids: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      intake: INTAKE_PROPERTY,
      escalate: { type: 'boolean' },
      escalation_reason: {
        type: 'string',
        enum: [...MODEL_SELECTABLE_REASONS],
      },
      no_kb_needed: { type: 'boolean' },
    },
    required: ['answer', 'cited_chunk_ids', 'confidence', 'escalate'],
    additionalProperties: false,
  },
};
