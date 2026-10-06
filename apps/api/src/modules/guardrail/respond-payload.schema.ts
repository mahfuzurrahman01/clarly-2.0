// A6/D11: schema-validates the model's terminal `respond` tool call — "one
// code path" per D11's own requirement ("schema-validated by one code
// path"). D12 lists this as GuardrailModule's job ("validate respond
// payload"), consumed by A4's loop (not built yet) as the terminal step.
import { z } from 'zod';
import { ESCALATION_REASONS } from '@repo/errors';

export const RespondPayloadSchema = z
  .object({
    answer: z.string().min(1, 'answer must not be empty'),
    cited_chunk_ids: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    escalate: z.boolean(),
    escalation_reason: z.enum(ESCALATION_REASONS).optional(),
    /**
     * D10 escape hatch for turns that legitimately need no knowledge base:
     * "hi", "thanks", "ok", and refusals to act on sensitive data. Without it
     * the zero-citation hard override forces confidence to 0 and every greeting
     * in a WhatsApp conversation is handed to a human — measured on the
     * 2026-08-16 eval, where a bare "hi" mid-conversation escalated.
     *
     * Only ever *relaxes* the zero-citation override, and only when the model
     * is not escalating; a fabricated citation still forces 0 regardless.
     */
    no_kb_needed: z.boolean().optional(),
    /**
     * F10: values the turn captured, keyed by the tenant's own field keys.
     * Unknown keys are dropped downstream rather than rejected here — a model
     * inventing a key must not cost the customer their answer, which
     * rejecting the whole payload would do.
     */
    intake: z
      .array(z.object({ key: z.string(), value: z.string() }))
      .optional(),
  })
  .refine(
    (payload) => !payload.escalate || payload.escalation_reason !== undefined,
    {
      message: 'escalation_reason is required when escalate is true',
      path: ['escalation_reason'],
    },
  );

export type RespondPayload = z.infer<typeof RespondPayloadSchema>;

export interface ParsedRespondPayload {
  ok: true;
  payload: RespondPayload;
}

export interface InvalidRespondPayload {
  ok: false;
  errors: string[];
}

/** Never throws — A4's loop treats a schema failure as a corrective-retry condition (RESCUE_POLICY.LLM_MALFORMED_TOOL_CALL), not an unhandled exception. */
export function parseRespondPayload(
  raw: unknown,
): ParsedRespondPayload | InvalidRespondPayload {
  const result = RespondPayloadSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, payload: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
